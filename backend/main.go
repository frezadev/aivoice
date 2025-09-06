package main

import (
	"flag"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
)

var (
	openaiApiKey      string
	serverPort        string
	openaiRealtimeURL = "wss://api.openai.com/v1/realtime?model=gpt-realtime"
	upgrader          = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	pingInterval      = 20 * time.Second
	writeWait         = 10 * time.Second
	readDeadline      = 60 * time.Second
)

func getEnv(key string) string {
	envFile, err := godotenv.Read("../config.env")
	if err != nil {
		log.Fatalf("Error loading .env file")
	}

	return envFile[key]
}

// Proxy connection client <-> OpenAI
func handleWebsocketProxy(w http.ResponseWriter, r *http.Request) {
	clientConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		http.Error(w, "websocket upgrade failed", http.StatusBadRequest)
		return
	}
	defer clientConn.Close()

	dialHeader := http.Header{}
	dialHeader.Set("Authorization", "Bearer "+openaiApiKey)

	serverConn, _, err := websocket.DefaultDialer.Dial(openaiRealtimeURL, dialHeader)
	if err != nil {
		log.Println("dial to openai failed:", err)
		_ = clientConn.WriteMessage(websocket.TextMessage, []byte(`{"error":"cannot connect to openai realtime"}`))
		return
	}
	defer serverConn.Close()

	errc := make(chan error, 2)

	// client -> server
	go func() {
		for {
			clientConn.SetReadDeadline(time.Now().Add(readDeadline))
			t, msg, err := clientConn.ReadMessage()
			if err != nil {
				errc <- err
				return
			}

			/* if t == websocket.TextMessage {
				var raw map[string]interface{}
				if err := json.Unmarshal(msg, &raw); err == nil {
					if raw["type"] == "response.create" {
						if _, exists := raw["modalities"]; !exists {
							raw["output_modalities"] = []string{"audio"}
						}
						raw["audio"] = map[string]interface{}{
							"voice":  "verse",
							"format": "wav",
						}
						raw["conversation"] = map[string]interface{}{
							"language": "en", // atau "en"
						}
						raw["instructions"] = "always answer with english, and simple answer"

						if patched, err := json.Marshal(raw); err == nil {
							msg = patched
						}
					}
				}
			} */

			serverConn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := serverConn.WriteMessage(t, msg); err != nil {
				errc <- err
				return
			}
		}
	}()

	// server -> client
	go func() {
		for {
			serverConn.SetReadDeadline(time.Now().Add(readDeadline))
			t, msg, err := serverConn.ReadMessage()
			if err != nil {
				errc <- err
				return
			}
			clientConn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := clientConn.WriteMessage(t, msg); err != nil {
				errc <- err
				return
			}
		}
	}()

	// ping loop to keep alive
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for range ticker.C {
			if err := clientConn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(writeWait)); err != nil {
				return
			}
		}
	}()

	if err := <-errc; err != nil && err != io.EOF {
		log.Println("proxy error:", err)
	}
}

func main() {
	serverPort = getEnv("SERVER_PORT")
	addr := flag.String("addr", ":"+serverPort, "http listen address")
	openaiApiKey = getEnv("OPENAI_API_KEY")

	if openaiApiKey == "" {
		log.Fatal("OpenAI API key required")
	}

	http.HandleFunc("/ws", handleWebsocketProxy)
	log.Println("Listening on", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
