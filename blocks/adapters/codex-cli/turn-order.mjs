export function mentorItemIsSuperseded(item, session) {
  const latestLearner = [...(session?.transcript || [])].reverse().find((message) => message?.role === "user");
  if (!latestLearner) return false;
  if (item?.type === "user_message") return latestLearner.id !== item.message?.id;
  return Boolean(item?.createdAt && latestLearner.createdAt && latestLearner.createdAt > item.createdAt);
}
