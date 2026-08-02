import React, { createContext, useContext } from 'react';

interface MessageSearchContextValue {
  query: string;
}

const MessageSearchContext = createContext<MessageSearchContextValue>({ query: '' });

export const MessageSearchProvider: React.FC<{
  query?: string;
  children: React.ReactNode;
}> = ({ query = '', children }) => (
  <MessageSearchContext.Provider value={{ query }}>
    {children}
  </MessageSearchContext.Provider>
);

export function useMessageSearchContext(): MessageSearchContextValue {
  return useContext(MessageSearchContext);
}
