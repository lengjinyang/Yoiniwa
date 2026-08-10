export function createRecoveringQueue() {
  let tail: Promise<unknown> = Promise.resolve();

  return function enqueue<T>(task: () => T | PromiseLike<T>): Promise<T> {
    const result = tail.catch(() => undefined).then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}
