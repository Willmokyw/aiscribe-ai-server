const express = require('express');
const axios = require('axios');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const VECTOR_API_KEY = process.env.VECTOR_API_KEY;
const FIREBASE_DB_URL = process.env.FIREBASE_DATABASE_URL; // e.g. https://your-project-default-rtdb.firebaseio.com
const FIREBASE_DB_SECRET = process.env.FIREBASE_DATABASE_SECRET;

if (!VECTOR_API_KEY) {
  console.warn('Warning: VECTOR_API_KEY is not set.');
}
if (!FIREBASE_DB_URL || !FIREBASE_DB_SECRET) {
  console.warn('Warning: FIREBASE_DATABASE_URL or FIREBASE_DATABASE_SECRET is not set.');
}

function buildFirebaseUrl(path) {
  const base = FIREBASE_DB_URL.replace(/\/$/, '');
  return `${base}${path}.json?auth=${encodeURIComponent(FIREBASE_DB_SECRET)}`;
}

app.post('/api/analyze-essay', async (req, res) => {
  try {
    const { essayText, language, userId } = req.body;

    if (!essayText || !essayText.trim()) {
      return res.status(400).json({ error: 'essayText is required' });
    }
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const lang = language || 'english';

    const systemPrompt = `
You are an AI writing teacher. Analyze the student's essay and return JSON with:
- overallScore, grammarScore, structureScore, styleScore (0-100 integers)
- comments: string[]
- correctedText: string
- corrections: { original, corrected, explanation, type }[]
Language: ${lang}.
Return ONLY valid JSON, no extra text.
`;

    const aiResponse = await axios.post(
      'https://api.vectorengine.ai/v1/chat/completions',
      {
        model: 'gemini-2.5-flash-thinking',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: essayText },
        ],
        temperature: 0.4,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          // VectorEngine 的 Authorization 直接用 key，不加 Bearer
          Authorization: VECTOR_API_KEY,
        },
      }
    );

    const aiMessage = aiResponse.data.choices[0].message.content;

    // 有些模型會用 ```json ... ``` 包住輸出，需要先清理
    let jsonText = aiMessage.trim();
    if (jsonText.startsWith('```')) {
      // 去除開頭和結尾的 ``` 或 ```json
      jsonText = jsonText
        .replace(/^```json/i, '')
        .replace(/^```/, '')
        .replace(/```$/,'')
        .trim();
    }
    // 再保險啲：只取第一個 { 到最後一個 } 之間嘅內容
    const firstBrace = jsonText.indexOf('{');
    const lastBrace = jsonText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonText = jsonText.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('Failed to parse AI JSON:', e);
      console.error('Raw content from model:', aiMessage);
      return res.status(500).json({ error: 'Failed to parse AI JSON' });
    }

    const {
      overallScore,
      grammarScore,
      structureScore,
      styleScore,
      comments,
      correctedText,
      corrections,
    } = parsed;

    const createdAt = new Date().toISOString();

    const essayData = {
      userId,
      originalText: essayText,
      correctedText,
      language: lang,
      createdAt,
      overallScore,
      grammarScore,
      structureScore,
      styleScore,
      comments,
      corrections,
    };

    // 在 Realtime Database 寫入 /essays/{userId}/{autoId}
    const pushUrl = buildFirebaseUrl(`/essays/${userId}`);
    const pushRes = await axios.post(pushUrl, essayData);
    const essayId = pushRes.data.name;

    // 更新 /users/{userId}/essayCount（用 server-side increment）
    const userUrl = buildFirebaseUrl(`/users/${userId}`);
    await axios.patch(userUrl, {
      essayCount: { '.sv': { increment: 1 } },
    });

    res.json({
      essayId,
      userId,
      originalText: essayText,
      correctedText,
      language: lang,
      createdAt,
      feedback: {
        overallScore,
        grammarScore,
        structureScore,
        styleScore,
        comments,
        corrections,
      },
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'AI service failed' });
  }
});

app.get('/', (_req, res) => {
  res.send('AIScribe AI Server (Realtime DB) is running');
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

