import React from 'react';
import { isVectorIndexUnavailable, useEmbeddingReadiness } from '../embeddingReadiness';
import { VectorIndexUnavailableNotice } from '../components/VectorIndexUnavailableNotice';
import IndexStatusView from './IndexStatusView';

/**
 * 索引状态页入口：未编入向量索引的构建上，资源会永远停在「待索引」、
 * 批量索引只会逐条失败——改为展示一句说明（检索仍走关键词账本）。
 */
export const IndexStatusGate: React.FC = () => {
  const readiness = useEmbeddingReadiness();
  if (isVectorIndexUnavailable(readiness)) {
    return (
      <div className="flex-1 overflow-auto p-4">
        <VectorIndexUnavailableNotice />
      </div>
    );
  }
  return <IndexStatusView />;
};

export default IndexStatusGate;
