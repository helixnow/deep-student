import type { DstuNode } from '@/dstu/types';
import type { ResourceListItem } from '@/components/learning-hub/types';
import {
  dstuNodeToResourceListItem,
  nodeTypeToFolderItemType,
} from '@/components/learning-hub/types';

/**
 * 将 openResource 返回的 DstuNode 映射为 Learning Hub 可打开资源
 */
export function mapDstuNodeToLearningHubItem(node: DstuNode): ResourceListItem | null {
  const itemType = nodeTypeToFolderItemType(node.type);
  if (!itemType) {
    return null;
  }

  return dstuNodeToResourceListItem(node, itemType);
}
