export function moveStep(ids: string[], from: number, to: number) {
  if (
    from < 0 ||
    to < 0 ||
    from >= ids.length ||
    to >= ids.length ||
    new Set(ids).size !== ids.length
  )
    throw Error("Invalid step move");
  const next = [...ids];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
