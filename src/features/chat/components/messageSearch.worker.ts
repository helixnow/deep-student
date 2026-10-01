import {
  createMessageSearchIndex,
  type MessageSearchRequest,
  type MessageSearchResponse,
} from './messageSearch';

const index = createMessageSearchIndex();
const workerScope = self as unknown as {
  onmessage: (event: MessageEvent<MessageSearchRequest>) => void;
  postMessage: (response: MessageSearchResponse) => void;
};

workerScope.onmessage = ({ data }) => {
  try {
    index.update(data);
    workerScope.postMessage({ requestId: data.requestId, matches: index.find(data.query) });
  } catch (error) {
    workerScope.postMessage({
      requestId: data.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
