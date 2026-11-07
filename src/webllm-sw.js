// /webllm-sw.js: keeps the localAI chat's model loaded in a service worker, so moving between pages
// doesn't load it again. Pages talk to it through WebLLM's ServiceWorkerMLCEngine (webllm-chat.js).
import { ServiceWorkerMLCEngineHandler } from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm";

// Created at the top, not on "activate", so it's there again whenever the browser restarts the worker
const handler = new ServiceWorkerMLCEngineHandler();

// Take over open pages straight away, so the first visit can use the worker without a reload
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

void handler;
