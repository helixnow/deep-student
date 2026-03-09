/**
 * TodoPage - 待办事项独立页面
 *
 * 脱离 Learning Hub / DSTU 的独立入口，
 * 直接渲染 TodoContentView。
 */

import React from 'react';
import { TodoContentView } from './TodoContentView';

export const TodoPage: React.FC = () => {
  return <TodoContentView className="h-full w-full" />;
};
