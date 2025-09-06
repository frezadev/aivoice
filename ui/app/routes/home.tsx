import type { Route } from "./+types/home";
import Voice from "../voice-chat/voice";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "AI Voice" },
    { name: "description", content: "AI Voice to help you" },
  ];
}

export default function Home() {
  return <Voice />;
}
