package main

import (
	"context"
	"io"
	"log"
	"os"

	"github.com/joho/godotenv"
	"github.com/openai/openai-go/v2"
	"github.com/openai/openai-go/v2/option"
)

func main() {
	res := voiceRequest()
	println(res.Text)
	println("-----------------------------")
	println(aiRequest(res.Text))
}

func getEnv(key string) string {
	envFile, err := godotenv.Read("../../config.env")
	if err != nil {
		log.Fatalf("Error loading .env file")
	}

	return envFile[key]
}

func aiRequest(question string) string {
	apiKey := getEnv("OPENAI_API_KEY")

	client := openai.NewClient(
		option.WithAPIKey(apiKey),
	)

	chatCompletion, err := client.Chat.Completions.New(context.TODO(), openai.ChatCompletionNewParams{
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.UserMessage(question),
		},
		Model: openai.ChatModelGPT4o,
	})
	if err != nil {
		panic(err.Error())
	}

	result := chatCompletion.Choices[0].Message.Content

	return (result)
}

func voiceRequest() openai.Transcription {
	audioFile := "./audios/record_en.m4a"

	file, err := os.Open(audioFile)
	if err != nil {
		log.Fatalf("Error opening file: %v", err.Error())
	}
	defer file.Close()

	var reader io.Reader = file

	apiKey := getEnv("OPENAI_API_KEY")

	client := openai.NewClient(
		option.WithAPIKey(apiKey), // defaults to os.LookupEnv("OPENAI_API_KEY")
	)

	result, err := client.Audio.Transcriptions.New(context.TODO(), openai.AudioTranscriptionNewParams{
		File:  io.Reader(reader),
		Model: openai.AudioModelWhisper1,
		// Prompt: openai.String("prompt"),
		/* ChunkingStrategy: openai.AudioTranscriptionNewParamsChunkingStrategyUnion{
			OfAuto: constant.ValueOf[constant.Auto](),
		},
		Include:                []openai.TranscriptionInclude{openai.TranscriptionIncludeLogprobs},
		Language:               openai.String("language"),
		ResponseFormat:         openai.AudioResponseFormatJSON,
		Temperature:            openai.Float(0),
		TimestampGranularities: []string{"word"}, */
	})
	if err != nil {
		log.Fatalf("Error voiceRequest")
	}

	return *result
}
