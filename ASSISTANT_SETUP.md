# Smart Assistant Setup

## 1) Add your API key

Create a `.env` file in this folder (same level as `server.js`) with:

```env
OPENAI_API_KEY=sk-...
PORT=3000
```

You can copy `.env.example` and rename it to `.env`.

## 2) Start the app

```bash
npm start
```

Then open:

`http://localhost:3000`

## 3) How archive data is used

- The frontend retrieves relevant historical archive cases from local app data.
- Those relevant cases are sent to `/api/openai-assistant`.
- The backend calls OpenAI and returns one human-style answer.
- No internet search is used for context; only your archive cases are passed in.
