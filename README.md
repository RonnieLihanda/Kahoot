# Ajira Quiz Arena

A live quiz game for trainings: the host shows a PIN and questions on the projector, up to 50 trainees join on their phones, and the top 5 are ranked at the end.

## Run locally
    npm install
    npm start          # http://localhost:3000  (host screen: /host)
    npm test           # simulates 50 players through all 20 questions

## Use it
1. Open `/host` on the projector or laptop. A 6-digit PIN appears.
2. Trainees open the site on their phones, type the PIN and a nickname.
3. Press Start game. Each question has a 20 second timer; faster correct answers score 500 to 1000 points.
4. After each question the host sees the correct answer, how many chose each option, and the top 5. Press Next (or Enter / Space).
5. At the end the top 5 podium appears.

Host extras: click a name in the lobby to remove a player; "End question now" skips the timer.

## Change the questions
Edit `questions.json` (20 questions now; any number works). Each question has `q`, `options` (2 to 4) and `answer` (the index of the right option, starting at 0). The server shuffles the options every game, so the right answer is never always in the same place. `timePerQuestion` is in seconds.

## Deploy on Render
1. Put this folder in a GitHub repo.
2. Render dashboard: New > Web Service > pick the repo (it reads `render.yaml`), plan Free.
3. Add environment variable `HOST_KEY` (any secret word). The host page will ask for it, so strangers cannot start games.
4. Free plans sleep after about 15 minutes idle, so open your URL 10 minutes before the training.

All game data is in memory and disappears when the service restarts. Do not run more than one instance.
