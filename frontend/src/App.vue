<template>
  <n-config-provider :theme="null">
    <n-global-style />
    
    <n-layout position="absolute">
      
      <n-layout-header bordered class="nav-header">
        <div class="nav-content">
          <div class="nav-brand">
            <img :src="logoUrl" alt="Logo" class="logo-icon" />
            <span class="brand-text">Crypto Tracker</span>
          </div>
          <div class="nav-actions">
            <span class="currency-label">Display Currency:</span>
            <n-select 
              v-model:value="currentCurrency" 
              :options="currencyOptions" 
              size="small"
              style="width: 130px" 
            />
          </div>
        </div>
      </n-layout-header>

      <n-layout-content class="main-content" :native-scrollbar="false">
        <div class="dashboard-container">

          <n-grid item-responsive responsive="screen" :x-gap="24" :y-gap="24" cols="1 m:3">
            
            <n-gi span="1">
              <div class="left-sidebar">
                <n-space vertical size="large">
                  
                  <n-card class="summary-card" title="Overview">
                    <n-statistic label="Total Net Worth">
                      <template #prefix>{{ currencySymbol }}</template>
                      <template #default>
                        <span class="total-balance">{{ formatMoney(totalPortfolioValue) }}</span>
                      </template>
                    </n-statistic>
                    
                    <n-divider style="margin: 16px 0" />
                    
                    <div class="mini-stats">
                      <div>
                        <div class="label">Wallets</div>
                        <div class="value">{{ results.length }}</div>
                      </div>
                      <div>
                        <div class="label">Chains</div>
                        <div class="value">{{ uniqueChainCount }}</div>
                      </div>
                    </div>

                    <n-button type="primary" dashed block style="margin-top: 20px" @click="showModal = true">
                      Manage Wallets
                    </n-button>
                  </n-card>

                  <n-card title="Allocation">
                    <div class="chart-container">
                      <v-chart class="chart" :option="chartOption" autoresize />
                    </div>
                  </n-card>

                </n-space>
              </div>
            </n-gi>

            <n-gi span="1 m:2">
              <div class="right-content">
                <div class="section-title">Wallet Holdings</div>
                
                <n-space vertical size="medium">
                  <n-card v-for="res in results" :key="res.address + res.chain" size="small" hoverable>
                    <n-thing>
                      <template #avatar>
                        <n-tag :type="getChainColor(res.chain)" round size="large" class="chain-tag">
                          {{ res.chain }}
                        </n-tag>
                      </template>
                      <template #header>
                        {{ res.chain }} Portfolio
                      </template>
                      <template #header-extra>
                        <div class="value-display">
                          <div class="fiat-value" :class="{ 'blur-text': loading }">
                            {{ currencySymbol }} {{ formatMoney(getValue(res)) }}
                          </div>
                          <div class="crypto-balance">
                            {{ res.balance?.toLocaleString() }} {{ res.chain }}
                          </div>
                        </div>
                      </template>
                      <template #description>
                        <span class="address-text">{{ shortenAddress(res.address) }}</span>
                      </template>
                    </n-thing>

                    <n-collapse arrow-placement="right" v-if="!res.error" style="margin-top: 12px;">
                      <n-collapse-item title="Recent Transactions">
                        <n-data-table
                          :columns="createColumns(res.chain)"
                          :data="res.transactions"
                          :pagination="false"
                          size="small"
                        />
                      </n-collapse-item>
                    </n-collapse>
                    <n-alert v-else type="error" :show-icon="true" style="margin-top: 10px;">{{ res.error }}</n-alert>
                  </n-card>

                  <n-empty v-if="results.length === 0" description="No wallets added yet" style="margin-top: 40px;">
                    <template #extra>
                      <n-button size="small" @click="showModal = true">Add Your First Wallet</n-button>
                    </template>
                  </n-empty>
                </n-space>
              </div>
            </n-gi>
            
          </n-grid>

        </div>
      </n-layout-content>
    </n-layout>

    <n-modal v-model:show="showModal">
      <n-card style="width: 600px" title="Manage Wallets" :bordered="false" size="huge" role="dialog" aria-modal="true">
        <n-space vertical>
          <div v-for="(item, index) in inputs" :key="index" class="input-row">
            <n-select v-model:value="item.chain" :options="coinOptions" style="width: 120px" />
            <n-input v-model:value="item.address" :placeholder="getPlaceholder(item.chain)" style="flex: 1" />
            <n-button type="error" ghost @click="removeRow(index)">X</n-button>
          </div>
          <n-button dashed block @click="addRow">+ Add Wallet</n-button>
          <n-button type="primary" block @click="fetchData" :loading="loading">Save & Update</n-button>
        </n-space>
      </n-card>
    </n-modal>
  </n-config-provider>
</template>

<script setup>
import { ref, computed, h, watch, onMounted } from 'vue';
import axios from 'axios';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { PieChart } from 'echarts/charts';
import { TitleComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import VChart from 'vue-echarts';
import { 
  NConfigProvider, NGlobalStyle, NLayout, NLayoutHeader, NLayoutContent,
  NCard, NSpace, NInput, NSelect, NButton, NGrid, NGi, NStatistic, 
  NDataTable, NTag, NDivider, NAlert, NCollapse, NCollapseItem, NModal, NThing, NEmpty
} from 'naive-ui';
import logoUrl from './assets/favicon.svg';

// --- ECharts 初始化 ---
use([CanvasRenderer, PieChart, TitleComponent, TooltipComponent, LegendComponent]);

// --- 常數設定 ---
const STORAGE_KEY = 'crypto_wallet_list';
const API_URL = '/api/portfolio';

const currencyOptions = [
  { label: '🇺🇸 USD ($)', value: 'usd' },
  { label: '🇪🇺 EUR (€)', value: 'eur' },
  { label: '🇨🇭 CHF (Fr)', value: 'chf' }
];

const coinOptions = [
  { label: 'Bitcoin (BTC)', value: 'BTC' },
  { label: 'Ethereum (ETH)', value: 'ETH' },
  { label: 'Solana (SOL)', value: 'SOL' },
  { label: 'Cardano (ADA)', value: 'ADA' },
];

// --- 狀態變數 ---
const loading = ref(false);
const showModal = ref(false);
const currentCurrency = ref('usd');
const results = ref([]);

// --- 1. LocalStorage 初始化 (讀取舊資料) ---
const getSavedWallets = () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try { return JSON.parse(saved); } catch (e) { console.error(e); }
  }
  return [{ chain: 'BTC', address: '' }];
};
const inputs = ref(getSavedWallets());

// --- 2. 監聽並自動存檔 ---
watch(inputs, (newVal) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(newVal));
}, { deep: true });

// --- 3. Computed 邏輯 ---
const currencySymbol = computed(() => ({ usd: '$', eur: '€', chf: 'Fr' }[currentCurrency.value] || ''));

const getValue = (wallet) => (wallet.value ? (wallet.value[currentCurrency.value] || 0) : 0);

const totalPortfolioValue = computed(() => results.value.reduce((sum, w) => sum + getValue(w), 0));

const uniqueChainCount = computed(() => new Set(results.value.filter(r => !r.error).map(r => r.chain)).size);

const chartOption = computed(() => {
  const allocation = {};
  results.value.forEach(w => {
    if(w.error) return;
    if (!allocation[w.chain]) allocation[w.chain] = 0;
    allocation[w.chain] += getValue(w);
  });
  const data = Object.keys(allocation).map(chain => ({ value: allocation[chain], name: chain }));

  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { orient: 'vertical', left: 'left' },
    series: [{
      name: 'Assets',
      type: 'pie',
      radius: ['40%', '70%'], // 甜甜圈圖
      itemStyle: { borderRadius: 10, borderColor: '#fff', borderWidth: 2 },
      label: { show: false, position: 'center' },
      emphasis: { label: { show: true, fontSize: 20, fontWeight: 'bold' } },
      data: data
    }]
  };
});

// --- Actions ---
const addRow = () => inputs.value.push({ chain: 'BTC', address: '' });
const removeRow = (idx) => inputs.value.splice(idx, 1);

const fetchData = async () => {
  // 過濾掉空地址
  const validInputs = inputs.value.filter(i => i.address && i.address.trim() !== '');
  if (validInputs.length === 0) return alert("請至少填寫一個地址");
  
  loading.value = true;
  showModal.value = false;
  try {
    const res = await axios.post(API_URL, { wallets: validInputs });
    results.value = res.data;
  } catch (e) {
    console.error(e);
    alert("連線後端失敗，請確認後端已啟動");
  } finally {
    loading.value = false;
  }
};

// --- Lifecycle: 自動載入 ---
onMounted(() => {
  if (inputs.value.some(i => i.address && i.address.trim() !== '')) {
    fetchData();
  } else {
    showModal.value = true;
  }
});

// --- UI Helpers ---
const formatMoney = (val) => val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const getPlaceholder = (c) => ({ BTC: 'Address / XPUB', ADA: 'addr1... / stake1...' }[c] || 'Address');
const getChainColor = (c) => ({ BTC:'warning', ETH:'info', SOL:'success', ADA:'primary' }[c] || 'default');
const shortenAddress = (a) => a && a.length > 20 ? a.slice(0,10)+'...'+a.slice(-6) : a;

const getExplorerLink = (chain, hash) => {
  if (chain === 'BTC') return `https://mempool.space/tx/${hash}`;
  if (chain === 'ETH') return `https://etherscan.io/tx/${hash}`;
  if (chain === 'SOL') return `https://solscan.io/tx/${hash}`;
  if (chain === 'ADA') return `https://cardanoscan.io/transaction/${hash}`;
  return '#';
};

const createColumns = (chain) => [
  { title: 'Date', key: 'date', width: 90 },
  { title: 'Hash', key: 'hash', 
    render(row) {
      if(!row.hash) return '-';
      return h('a', { href: getExplorerLink(chain, row.hash), target: '_blank', style: 'color: #36ad6a; text-decoration: none;' }, 'View Tx');
    }
  },
  { title: 'Info', key: 'value' }
];
</script>

<style scoped>
/* Header 樣式 */
.nav-header { height: 64px; display: flex; align-items: center; justify-content: center; background: #fff; border-bottom: 1px solid #eee; z-index: 100; }
.nav-content { width: 100%; max-width: 1280px; padding: 0 20px; display: flex; justify-content: space-between; align-items: center; }
.nav-brand { font-size: 20px; font-weight: 800; color: #333; display: flex; align-items: center; gap: 8px; }
.nav-actions { display: flex; align-items: center; gap: 10px; }
.currency-label { font-size: 13px; color: #666; display: none; }
@media(min-width:600px) { .currency-label { display: block; } }

/* 佈局樣式 */
.main-content { background-color: #f5f7fa; }
.dashboard-container { max-width: 1280px; margin: 0 auto; padding: 24px 20px 60px 20px; }

/* 左側邊欄 (Sticky) */
.left-sidebar { position: sticky; top: 24px; }
.chart-container { height: 300px; }
.total-balance { font-size: 32px; font-weight: 700; color: #18a058; line-height: 1.1; word-break: break-all; }

/* 迷你統計 */
.mini-stats { display: flex; justify-content: space-around; text-align: center; }
.mini-stats .label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
.mini-stats .value { font-size: 18px; font-weight: bold; color: #333; }

/* 右側列表 */
.section-title { font-size: 18px; font-weight: 600; color: #444; margin-bottom: 16px; }

/* 卡片細節 */
.value-display { text-align: right; }
.fiat-value { font-weight: 700; font-size: 15px; color: #333; }
.blur-text { filter: blur(4px); }
.crypto-balance { font-size: 12px; color: #999; margin-top: 4px; }
.address-text { font-size: 12px; color: #bbb; font-family: monospace; }
.chain-tag { width: 50px; justify-content: center; }
.input-row { display: flex; gap: 8px; margin-bottom: 8px; }

.logo-icon {
  width: 30px;  /* 設定寬度 */
  height: 30px; /* 設定高度 */
  display: block; /* 避免圖片下方有多餘空白 */
}
</style>