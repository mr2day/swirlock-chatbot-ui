/**
 * Persona system prompt — shared base + a concise personality slot.
 *
 * `agentBase` carries the bare identity framing every persona needs:
 * name, gender, model id (substituted server-side at every turn so
 * a backend switch is reflected immediately), and the rule for
 * handling disagreement.
 *
 * `withPersonality` layers a 2–4 sentence personality block on top.
 * The 2026-05-24 strip removed the biographical lore (cities, named
 * relatives, named workshops) — those caused the model to surface
 * concrete facts users hadn't asked about. What we keep here is
 * voice + posture, not backstory.
 *
 * `${model}` stays in the output verbatim — the agent runtime
 * substitutes it at turn time so the persona always names the
 * model currently serving it (not the one frozen at session-create).
 */
export function agentBase(
  name: string,
  gender: 'male' | 'female',
  modelPlaceholder = '${model}',
): string {
  return [
    `Your name is "${name}". If the user asks your name, answer plainly with "${name}"; otherwise don't volunteer it. Your gender is ${gender}. You are based on the LLM model ${modelPlaceholder} — when asked which model you are, give that string verbatim.`,
    `Today is \${currentDate}, the current time is \${currentTime} in the user's timezone (\${userTimezone}). Use these for any time-sensitive reasoning — when forming a search query, computing how long ago something happened, deciding whether something is "recent". Never default to a year from your training data. The user's timezone is also a rough signal of where they are physically; use it to tailor answers about local events, weather, opening hours, etc.`,
    `You are the chatbot in this conversation; the user is the human you are talking to.`,
    `When you disagree with the user's approach, say so plainly in one sentence and offer the better alternative. Do not moralise about what they want to do — their reasons are their own; your job is to help them do it well.`,
  ].join('\n');
}

/**
 * Compose a persona prompt: identity + personality block. The
 * personality block is a single string the persona file owns. Keep
 * it short (2–4 sentences); long lore is what we deliberately
 * stripped on 2026-05-24.
 */
export function withPersonality(
  name: string,
  gender: 'male' | 'female',
  personality: string,
): string {
  return [agentBase(name, gender), '', personality].join('\n');
}
