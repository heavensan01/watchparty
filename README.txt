UNIFLIX v11  (no helper, no movie upload)

DEPLOY (Render / local)
  npm install   then   npm start   ->  http://localhost:3000
  Render: Build command "npm install", Start command "npm start".

HOW IT WORKS
  - Host clicks "Video file": the movie starts instantly from the device (nothing is uploaded).
  - In the background the host's own browser (ffmpeg.wasm, served by this site) reads the file:
      * lists all audio languages -> 🎧 Audio menu
      * extracts text subtitles   -> 💬 Subs menu for everyone (tiny text, the only thing sent)
  - Picking a different audio language switches in a few seconds:
    The browser converts the chosen track about 20 seconds at a time, just ahead of the video, so sound starts within seconds.
    Works for AC3 / DTS / EAC3 too.
