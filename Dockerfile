# === 階段 1: 建置前端 (Builder) ===
FROM node:20-alpine as frontend-builder

WORKDIR /app/frontend

# 複製 package.json 並安裝依賴
COPY frontend/package*.json ./
RUN npm install

# 複製原始碼並打包 (Build)
COPY frontend/ ./
RUN npm run build


# === 階段 2: 設定後端並運行 (Runtime) ===
FROM node:20-alpine

WORKDIR /app

# 設定環境變數
ENV NODE_ENV=production

# 複製後端依賴設定
COPY backend/package*.json ./backend/

# 進入 backend 資料夾安裝依賴
WORKDIR /app/backend
RUN npm install --production

# 複製後端程式碼
COPY backend/ ./

# === 關鍵步驟: 把階段 1 打包好的 Vue 檔案複製到後端 ===
# 我們把它複製到 backend/public 資料夾，這樣上面的 index.js 就能讀到了
COPY --from=frontend-builder /app/frontend/dist ./public

# 開放 Cloud Run 預設的 8080 (雖然 Cloud Run 會由環境變數決定，但寫著比較清楚)
EXPOSE 8080

# 啟動伺服器
CMD ["node", "index.js"]