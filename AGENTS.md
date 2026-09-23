# Setting up Roster (for coding agents)

Roster is a local Node app. When a user asks you to set it up, do this in order:

1. `npm install`, then `cp .env.example .env` if `.env` does not exist. Needs Node 22.5+ (`node -v`); it uses the built-in `node:sqlite`.
2. `npm start`, then open http://localhost:4747 for the user.
3. **Luma cookie: hand this step to the user.** Say: "On luma.com open DevTools, Application, Cookies, https://luma.com, copy the value of `luma.auth-session-key`, and paste it into Roster's Settings." You cannot read browser cookies, and you must not ask the user to paste the cookie into chat.
4. **AI provider.** Default is the user's Claude Code login: check `command -v claude` and that `claude -p "hi"` works. If the user is on Codex instead, check `command -v codex` and `codex login status`, then tell them to pick "My Codex login" in Settings. Only use an Anthropic API key if the user explicitly wants to pay per use; they paste it into Settings themselves.
5. Verify: `curl -s localhost:4747/api/status` should return an empty `notices` array. Each notice names what is missing (cookie, provider) and how to fix it.
6. Tell the user to edit "Who I am and who I want to meet" in Settings. It is the prompt every guest is scored against.

Rules: never commit `.env`, `data/`, or `me.md` (all gitignored). Never put a cookie or key in a commit, chat message, or log. The Luma calls in `src/luma.mjs` use Luma's private web API; do not add scraping of LinkedIn or other sites.
