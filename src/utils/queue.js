// Simple in-memory queue with delay — no Redis needed
export async function sendWithDelay(tasks, delayMs, onSend) {
  for (const task of tasks) {
    await onSend(task)
    const jitter = delayMs + Math.floor(Math.random() * 5000)
    await new Promise(r => setTimeout(r, jitter))
  }
}