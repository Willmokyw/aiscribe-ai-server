# AIScribe AI Server（Node + Database Secret）

呢個資料夾係 AIScribe / GradeMyEssay 專用嘅 **Node.js 後端**，用嚟：

- 接收 iOS App 傳入嘅文章內容同 `userId`
- 用 VectorEngine（`https://api.vectorengine.ai/v1/chat/completions`）做 AI 分析
- 拿到 AI JSON 結果之後，用 **Firebase Realtime Database 的 Database Secret** 直接寫入整個 database
- 回傳整理好嘅 `Essay + Feedback` 結果畀 iOS App

> 重點：**Database Secret 只存在喺 server（Render / 本機 `.env`）**，永遠唔會落去 iOS App bundle。

---

## 1. 安裝環境

### 1.1 進入資料夾

```bash
cd /Users/willmok/Desktop/GradeMyEssay/ai-server
```

### 1.2 安裝依賴

如果係新環境：

```bash
cd ai-server
npm install
```

---

## 2. 設定 .env（VectorEngine + Firebase Database Secret）

喺 `ai-server` 根目錄新建 `.env` 檔案（**唔好 commit 上 GitHub**）：

```bash
cd ai-server
touch .env
```

內容格式如下（用你自己嘅實際值取代）：

```bash
VECTOR_API_KEY=你喺 VectorEngine 拿到嘅 API KEY
PORT=10000

# Firebase Realtime Database
FIREBASE_DATABASE_URL=https://your-project-id-default-rtdb.firebaseio.com
FIREBASE_DATABASE_SECRET=你的_database_secret
```

Database Secret 可以喺 Firebase Console：

- Realtime Database → Settings / Secrets（Database secrets）裏面睇到。

### 2.1 確保 .env 唔會被 commit

最外層專案（GradeMyEssay）嘅 `.gitignore` 建議加入：

```gitignore
ai-server/.env
```

---

## 3. 伺服器程式入口：index.js

`index.js` 主要邏輯：

- 使用 `express` 建立 HTTP server
- 使用 `cors` 容許 iOS / web client 訪問
- 使用 `dotenv` 讀取 `.env`
- 使用 **Firebase Realtime Database REST API + Database Secret** 控制整個 database
- 建立一個 `POST /api/analyze-essay` 端點：
  - Body: `{ "essayText": "...", "language": "english", "userId": "<firebase uid>" }`
  - 檢查 `essayText`、`userId` 必填
  - 建立 system prompt，規定模型必須輸出 JSON 結構（scores、comments、correctedText、corrections）
  - 用 `axios` POST 去 `https://api.vectorengine.ai/v1/chat/completions`
  - 將 `choices[0].message.content` parse 成 JSON
  - 在 Realtime Database：
    - `POST /essays/{userId}.json?auth=SECRET` 寫入一筆新 essay，讓 Firebase 自動產生 `essayId`
    - `PATCH /users/{userId}.json?auth=SECRET`，用 `{ "essayCount": {".sv":{"increment":1}} }` 增加 essay 計數
  - 回傳：

```json
{
  "essayId": "<firebase generated key>",
  "userId": "UID",
  "originalText": "...",
  "correctedText": "...",
  "language": "english",
  "createdAt": "2026-03-16T12:34:56.000Z",
  "feedback": {
    "overallScore": 85,
    "grammarScore": 90,
    "structureScore": 80,
    "styleScore": 82,
    "comments": ["..."],
    "corrections": [
      {
        "original": "wrong",
        "corrected": "right",
        "explanation": "Because ...",
        "type": "grammar"
      }
    ]
  }
}
```

---

## 4. 本機啟動同測試

### 4.1 啟動 server

```bash
cd ai-server
npm start
```

預設會 listen 喺 `http://localhost:10000`。

### 4.2 用 curl 測試

```bash
curl -X POST http://localhost:10000/api/analyze-essay \
  -H "Content-Type: application/json" \
  -d '{
    "essayText": "This is a test essay.",
    "language": "english",
    "userId": "TEST_USER_ID"
  }'
```

成功時：

- 你會收到上面 JSON 結果；
- Realtime Database 裏面會多咗：
  - `/essays/TEST_USER_ID/{autoId}` 一筆新紀錄
  - `/users/TEST_USER_ID/essayCount` 自動 +1

---

## 5. 部署去 Render

1. 將 `ai-server` push 去 GitHub（**唔好** 包括 `.env`）。  
2. Render 建新 Web Service：
   - Environment：`Node`
   - Build Command：`npm install`
   - Start Command：`npm start`
3. 在 Render Service 的 **Environment Variables** 加入：
   - `VECTOR_API_KEY`
   - `FIREBASE_DATABASE_URL`
   - `FIREBASE_DATABASE_SECRET`
   - （可選）`PORT`
4. 部署完成後，你會得到：

```text
https://aiscribe-ai-server.onrender.com
```

可以用：

```bash
curl -X POST https://aiscribe-ai-server.onrender.com/api/analyze-essay \
  -H "Content-Type: application/json" \
  -d '{
    "essayText": "This is a test essay from Render.",
    "language": "english",
    "userId": "TEST_USER_ID"
  }'
```

---

## 6. iOS App 點樣用？

在 iOS App 裏面（`AIService.swift`）：

- URL: `https://aiscribe-ai-server.onrender.com/api/analyze-essay`
- Method: `POST`
- Body JSON：

```json
{
  "essayText": ".....",
  "language": "english",
  "userId": "<Firebase UID>"
}
```

Server 回返上面格式嘅 JSON：

- 你可以用 `JSONDecoder` 解碼成 `Essay` + `Feedback`。
- 歷史紀錄可以直接用 Firebase iOS SDK 從 Realtime Database `/essays/{userId}` 抓返，或者繼續用你現有嘅 Firestore 結構另行同步（按你實際設計）。

---

## 7. 安全注意事項

- **Database Secret = 完整 Database 管理權**，一定要：
  - 只放喺 `.env` 或 Render Environment Variables；
  - 絕對唔好落去 iOS App 或前端代碼；
  - 一旦懷疑洩漏，即刻 rotate secret（Firebase Console 重新產生一個新 secret，舊嘅停用）。
- 建議 Realtime Database 規則依然設定得嚴謹，限制 client-side 直接讀寫範圍，將高權限操作集中喺呢個 Node server。

