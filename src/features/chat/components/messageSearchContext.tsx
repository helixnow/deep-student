import React, { createContext, useContext, useMemo } from 'react';

interface MessageSearchContextValue {
  query: string;
}

const MessageSearchContext = createContext<MessageSearchContextValue>({ query: '' });

export const MessageSearchProvider: React.FC<{
  query?: string;
  children: React.ReactNode;
}> = ({ query = '', children }) => {
  // ★ 修复：value 必须保持稳定引用。宿主 MessageItem 会因划词工具条显隐等
  // 本地状态频繁重渲染；若 value 每次都是新对象，context 传播会穿透
  // MarkdownRenderer 的 React.memo 强制其重渲染——其内联 components={{...}}
  // 随之生成全新函数引用，react-markdown 将所有 <p> 视为不同类型而卸载重建，
  // 选区锚定的文本节点被销毁，划词高亮在工具条弹出瞬间消失。
  const value = useMemo<MessageSearchContextValue>(() => ({ query }), [query]);
  return (
    <MessageSearchContext.Provider value={value}>
      {children}
    </MessageSearchContext.Provider>
  );
};

export function useMessageSearchContext(): MessageSearchContextValue {
  return useContext(MessageSearchContext);
}
