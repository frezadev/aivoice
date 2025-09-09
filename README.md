# aivoice (React + Golang + OpenAI)

This project creates a ChatGPT Voice–like application:
- **Frontend**: React + TypeScript (TSX), using AudioWorklet to capture microphone input, waveform visualization (mic & output), and playback of audio responses from OpenAI.
- **Backend**: Golang, as a WebSocket proxy between the client and OpenAI Realtime API.
- **OpenAI Realtime API**: provides two-way conversation (voice-in + voice-out).

---

## Features
- Capture microphone audio, downsample to 16kHz PCM16.
- Send audio chunks to the backend via WebSocket.
- Backend proxies to OpenAI Realtime (commit + response.create).
- Playback audio responses from OpenAI with circular waveform visualization (mic: yellow, output: green).
- Display chat logs (text transcripts).

---

## Project Structure
```

project-root/
│
├── backend/
│ ├── main.go # WebSocket proxy server to OpenAI
│ └── go.mod
|
├── consoleApp/ #console app to transcript audio file and process it into openapi
| └── withReadFile/
|     ├── audios/ # audio files that need to transcript to openai
|     └── main.go # main go to run
| └── withRecordingFunction/ 
|     └── main.go # main go to run
|
├── frontend/
│ ├── src/
│ │ ├── App.tsx # Main React component
│ │ ├── recorder-worklet.js # AudioWorklet
│ │ └── ...
│ └── package.json
│
│── config.env #needs to provide by yourself consist of OPENAI_API_KEY and SERVER_PORT
└── README.md

````

---

## First thing To Do
You need to create `config.env` file inside the main folder, this file should have:
```
OPENAI_API_KEY=sk-proj-....
SERVER_PORT=8080
```

## Console Apps

### withReadFile
This is the console application that will read an audio file, and give response based on the audio file transcription
1. Place the audio file under `/consoleApp/withReadFile/audios`
2. Change this line of code under `voiceRequest` function `audioFile := "./audios/audio_name"`
3. Run main.go

### withRecordingFunction
This is the console application that will listen your voice and give a response
1. Instal this library:
   Mac OS:
   ```
   brew install pkg-config
   brew install portaudio
   ````

   Linux:
   ```
   apt-get install portaudio19-dev
   ````
   
3. Run main.go
4. Type `start` to talk
5. Type `stop` to get the response
6. Type `exit` to exit the console app 

## Web Based

### 1. Run Backend (Golang)
Make sure you have Go 1.22+ installed and your `OPENAI_API_KEY` is set inside config.env file

```bash
cd backend
go mod tidy
go run main.go
````

This will start a WebSocket server on port that already set inside config.env SERVER_PORT

```
ws://localhost:SERVER_PORT/ws
```

---

### 2. Run Frontend (React + Vite)

```bash
cd frontend
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Hotkeys

* **Connect** → open WebSocket connection to backend and begin capturing mic and sending audio.
* **Mute Mic** → stop mic, commit buffer, and trigger response.
* * **Unmute Mic** → start capturing mic.
* **Show logs** → show logs file at the bottom.

---

## Notes

* Browser must support **AudioWorklet** (Chrome, Edge, latest browsers).
* Playback speed can be tuned by changing:

  ```ts
  src.playbackRate.value = 1.4;
  ```
* Visualizer:

  * **Yellow Circle** → Mic input
  * **Green Circle** → AI output

---

## License

MIT
