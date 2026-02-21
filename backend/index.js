// ==========================================
// Crypto Tracker Backend (Node.js + Express)
// 採用 Node 20+ 現代 ES Modules (ESM) 規範
// ==========================================
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { Connection, PublicKey, clusterApiUrl, LAMPORTS_PER_SOL } from '@solana/web3.js';
import path from 'path';

// 為了確保在 Docker 環境中，相對路徑不會因為執行目錄不同而跑位，一律使用 process.cwd() 錨定專案根目錄。
const staticPath = path.join(process.cwd(), 'public');

const app = express();

// 允許跨域請求，確保本地開發時 Vite 前端 (通常在 5173 埠) 能夠順利呼叫此 API
app.use(cors());
// 必須解析 JSON，因為前端是透過 axios.post 發送 JSON 格式的錢包清單
app.use(express.json());

// 配合 Google Cloud Run 的動態通訊埠配置；若無環境變數 (如本地開發)，則退回 3000
const PORT = process.env.PORT || 3000;

// Solana 官方 SDK 需要透過 RPC 節點才能讀取鏈上狀態，此處使用官方提供的公有節點
const solanaConnection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// CoinGecko API 需要特定的 internal ID 來查詢報價，因此建立此映射表以轉換我們定義的鏈代號
const COIN_GECKO_IDS = {
    'BTC': 'bitcoin',
    'ETH': 'ethereum',
    'SOL': 'solana',
    'ADA': 'cardano'
};

// --- 鏈處理邏輯 (Chain Handlers) ---
const chainHandlers = {
    
    // 為了同時支援冷錢包 (XPUB) 與單筆地址，需依據字串特徵進行分流
    BTC: async (rawAddress) => {
        // 使用者從 App 複製地址時，常意外夾帶隱形空白或換行符號，需預先清洗以避免 API 報錯
        const address = rawAddress.trim().replace(/\s/g, '');

        // 防禦性設計：阻擋包含非 Base58 字元的惡意或錯誤輸入，減少無效的對外 API 請求浪費
        if (/[^a-zA-Z0-9]/.test(address)) {
             return { chain: 'BTC', address: rawAddress, error: "地址包含非法字元 (請重新複製，勿含標點或特殊符號)" };
        }

        try {
            // Ledger 等硬體錢包會提供 xpub/ypub/zpub 作為母公鑰，以此衍生無限個子地址
            const isXpub = address.match(/^(xpub|ypub|zpub|vpub|upub)/i);

            if (isXpub) {
                // Blockchain.info 是目前免費 API 中，少數能良好支援展開並計算 XPUB 總餘額的服務
                const { data } = await axios.get(`https://blockchain.info/multiaddr?active=${address}&n=5`);
                const balanceBtc = data.wallet.final_balance / 100000000;
                
                const transactions = data.txs.slice(0, 5).map(tx => ({
                    hash: tx.hash,
                    value: "XPUB Activity",
                    date: new Date(tx.time * 1000).toLocaleDateString(),
                    type: "MIXED"
                }));
                return { chain: 'BTC', address, balance: balanceBtc, transactions };

            } else {
                // 一般地址查詢改用 Blockstream，因為它的限流政策較寬鬆，且對 SegWit 地址支援度極高
                const { data: addressInfo } = await axios.get(`https://blockstream.info/api/address/${address}`);
                const { data: txsData } = await axios.get(`https://blockstream.info/api/address/${address}/txs`);

                // 比特幣採 UTXO 模型，沒有絕對的「餘額」欄位。必須將歷史總入帳 (funded) 扣除已花費 (spent)，
                // 同時加上記憶體池 (mempool) 中未確認的交易，才能反映出真實且即時的可用資產。
                const balanceSat = (addressInfo.chain_stats.funded_txo_sum - addressInfo.chain_stats.spent_txo_sum) +
                                   (addressInfo.mempool_stats.funded_txo_sum - addressInfo.mempool_stats.spent_txo_sum);
                
                const balanceBtc = balanceSat / 100000000;

                const transactions = txsData.slice(0, 5).map(tx => ({
                    hash: tx.txid,
                    value: (tx.status.confirmed) ? "Confirmed" : "Pending...",
                    date: tx.status.block_time ? new Date(tx.status.block_time * 1000).toLocaleDateString() : "Mempool",
                    type: "TX"
                }));
                return { chain: 'BTC', address, balance: balanceBtc, transactions };
            }
        } catch (e) {
            // 精準捕捉 HTTP 400 錯誤，以便向前端反饋是格式問題，而非伺服器掛點
            if (e.response && e.response.status === 400) return { chain: 'BTC', address, error: "格式錯誤 (請確認是有效 XPUB 或地址)" };
            return { chain: 'BTC', address, error: "查詢失敗 (API 限制或無效地址)" };
        }
    },

    ETH: async (address) => {
        try {
            // 棄用 Etherscan 免費版 (需註冊 key 且容易限流)，改用 Blockscout API 以降低基礎設施維護成本
            const { data } = await axios.get(`https://eth.blockscout.com/api?module=account&action=balance&address=${address}`);
            const balanceEth = parseInt(data.result) / 1e18;
            return { chain: 'ETH', address, balance: balanceEth, transactions: [] }; 
        } catch (e) {
            return { chain: 'ETH', address, error: "查詢失敗 (Check Address)" };
        }
    },

    SOL: async (address) => {
        try {
            const pubKey = new PublicKey(address);
            // 區塊鏈底層皆以整數 (Lamports) 紀錄資產，必須除以精度轉換回人類可讀的 SOL 單位
            const balanceLamports = await solanaConnection.getBalance(pubKey);
            const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

            // 抓取近 5 筆簽章，並判斷 err 欄位以標示交易成功與否
            const signatures = await solanaConnection.getSignaturesForAddress(pubKey, { limit: 5 });
            const transactions = signatures.map(sig => ({
                hash: sig.signature,
                value: "Solana Action",
                date: new Date(sig.blockTime * 1000).toLocaleDateString(),
                type: sig.err ? 'Fail' : 'Success'
            }));
            return { chain: 'SOL', address, balance: balanceSol, transactions };
        } catch (e) {
            return { chain: 'SOL', address, error: "無效 SOL 地址" };
        }
    },

    ADA: async (address) => {
        try {
            // Cardano 的特殊設計：付款地址 (addr1) 與質押地址 (stake1) 是分開的，需辨識前綴以決定呼叫哪個 endpoint
            const isStake = address.startsWith('stake1');
            let balanceAda = 0;
            let transactions = [];

            // 為了防止交易紀錄 API (B) 的不穩定導致整個餘額查詢 (A) 失敗，這裡將 Try-Catch 拆分為兩個獨立區塊，實現降級容錯
            try {
                const url = isStake ? 'account_info' : 'address_info';
                const body = isStake ? { _stake_addresses: [address] } : { _addresses: [address] };
                const { data } = await axios.post(`https://api.koios.rest/api/v1/${url}`, body);
                
                if (data && data.length > 0) {
                    const bal = isStake ? data[0].total_balance : data[0].balance;
                    balanceAda = parseInt(bal || 0) / 1000000;
                }
            } catch (err) { console.error("ADA Balance Fetch Error"); }

            try {
                const urlTx = isStake ? 'account_txs' : 'address_txs';
                const bodyTx = isStake ? { _stake_addresses: [address] } : { _addresses: [address] };
                const { data: txs } = await axios.post(`https://api.koios.rest/api/v1/${urlTx}`, bodyTx);
                
                if (txs) {
                    transactions = txs.slice(0, 5).map(tx => ({
                        hash: tx.tx_hash,
                        value: "ADA Tx",
                        date: tx.block_time ? new Date(tx.block_time * 1000).toLocaleDateString() : "Pending",
                        type: "TX"
                    }));
                }
            } catch (err) {
                // 若交易紀錄取得失敗，注入提示資訊回傳前端，而非直接拋出 Exception 導致畫面卡死
                transactions = [{ hash: "", value: "API 暫時無法讀取歷史", date: "Info", type: "INFO" }];
            }

            return { chain: 'ADA', address, balance: balanceAda, transactions };
        } catch (e) {
            return { chain: 'ADA', address, error: "查詢嚴重錯誤" };
        }
    }
};

// --- 主要 API Endpoint ---
app.post('/api/portfolio', async (req, res) => {
    const { wallets } = req.body;
    if (!wallets || !Array.isArray(wallets)) return res.status(400).json({ error: "Invalid input format" });

    try {
        // 為了極小化使用者的等待時間，使用 Promise.all 將所有錢包的 API 請求並行發送，而非依序等待
        const promises = wallets.map(wallet => {
            const handler = chainHandlers[wallet.chain];
            // 遇到未定義的公鏈直接 resolve 錯誤狀態，避免影響其他正常錢包的執行
            return handler ? handler(wallet.address) : Promise.resolve({ ...wallet, error: "Unsupported Chain" });
        });
        const walletResults = await Promise.all(promises);

        // 為了避免重複向 CoinGecko 請求相同幣種而遭到 Rate Limit 封鎖，先過濾出唯一的公鏈清單
        const uniqueChains = [...new Set(walletResults.filter(w => !w.error).map(w => w.chain))];
        const geckoIds = uniqueChains.map(c => COIN_GECKO_IDS[c]).join(',');
        
        let prices = {};
        if (geckoIds) {
            try {
                const { data } = await axios.get(`https://api.coingecko.com/api/v3/simple/price`, {
                    params: { ids: geckoIds, vs_currencies: 'usd,eur,chf' }
                });
                prices = data;
            } catch (e) { console.error("CoinGecko Price API Error:", e.message); }
        }

        // 將非同步抓取回來的資產數量與外部匯率進行映射計算，組裝成最終資料供前端直接渲染
        const finalResults = walletResults.map(item => {
            if (item.error) return item;
            
            const geckoId = COIN_GECKO_IDS[item.chain];
            const p = prices[geckoId] || { usd: 0, eur: 0, chf: 0 };
            
            return {
                ...item,
                price: p,
                value: {
                    usd: item.balance * p.usd,
                    eur: item.balance * p.eur,
                    chf: item.balance * p.chf
                }
            };
        });

        res.json(finalResults);
    } catch (error) {
        // 捕捉預期外的 Server 崩潰，避免曝露 Stack Trace 給客戶端造成資安風險
        console.error("Critical Server Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 為了讓這支 Node 程式能同時扮演「API 伺服器」與「靜態網頁伺服器」，在此攔截根目錄請求，返回打包好的前端資源
app.use(express.static(staticPath));

// 由於前端採用 Vue Router 進行前端路由 (SPA)，所有的非 API 路徑都必須導向 index.html。
// 使用 RegExp /^.*/ 而非傳統的 '*'，是為了避免 Express 5+ 嚴格模式下拋出 Missing parameter name 錯誤。
app.get(/^.*/, (req, res) => {
    res.sendFile(path.join(staticPath, 'index.html'));
});

// 必須綁定 '0.0.0.0' 以開放所有網路介面。如果只綁定預設的 localhost，
// Google Cloud Run 或 Docker 的外部 Health Check 將無法進入容器內部，導致部署失敗。
app.listen(PORT, '0.0.0.0', () => console.log(`Backend running on port ${PORT} (ESM Mode)`));