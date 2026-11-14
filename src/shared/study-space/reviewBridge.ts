type ReviewHandler = (cardIds: string[]) => Promise<boolean>;

let handler: ReviewHandler | null = null;
let pendingCardIds: string[] | null = null;

/** Classic shell loads the flashcard store lazily; keep the request until it registers. */
export function provideStudySpaceReview(next: ReviewHandler): void {
  handler = next;
  if (pendingCardIds !== null) {
    const ids = pendingCardIds;
    pendingCardIds = null;
    void next(ids);
  }
}

export function requestStudySpaceReview(cardIds: string[]): Promise<boolean> {
  if (handler) return handler(cardIds);
  pendingCardIds = cardIds;
  return Promise.resolve(cardIds.length > 0);
}
