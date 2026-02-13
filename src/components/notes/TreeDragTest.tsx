import React, { useState } from 'react';
import { UncontrolledTreeEnvironment, Tree, StaticTreeDataProvider, ControlledTreeEnvironment } from 'react-complex-tree';
import 'react-complex-tree/lib/style-modern.css';
import { enableWebDrag } from '../../utils/tauriDragFix';

// 测试数据
const items = {
  root: {
    index: 'root',
    isFolder: true,
    children: ['folder1', 'folder2', 'file1', 'file2'],
    data: { title: 'Root' }
  },
  folder1: {
    index: 'folder1',
    isFolder: true,
    children: ['file3', 'file4'],
    data: { title: 'Folder 1' }
  },
  folder2: {
    index: 'folder2',
    isFolder: true,
    children: ['file5', 'subfolder1'],
    data: { title: 'Folder 2' }
  },
  subfolder1: {
    index: 'subfolder1',
    isFolder: true,
    children: ['file6'],
    data: { title: 'Subfolder 1' }
  },
  file1: {
    index: 'file1',
    isFolder: false,
    children: [],
    data: { title: 'File 1' }
  },
  file2: {
    index: 'file2',
    isFolder: false,
    children: [],
    data: { title: 'File 2' }
  },
  file3: {
    index: 'file3',
    isFolder: false,
    children: [],
    data: { title: 'File 3' }
  },
  file4: {
    index: 'file4',
    isFolder: false,
    children: [],
    data: { title: 'File 4' }
  },
  file5: {
    index: 'file5',
    isFolder: false,
    children: [],
    data: { title: 'File 5' }
  },
  file6: {
    index: 'file6',
    isFolder: false,
    children: [],
    data: { title: 'File 6' }
  }
};

export default function TreeDragTest() {
  const [expandedItems, setExpandedItems] = useState<string[]>(['root', 'folder1', 'folder2', 'subfolder1']);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [focusedItem, setFocusedItem] = useState<string>('root');
  const [treeData, setTreeData] = useState(items);

  // 确保组件挂载时修复 Tauri 拖拽问题
  React.useEffect(() => {
    enableWebDrag();
  }, []);

  return (
    <div className="tree-drag-test-container h-screen w-full bg-background p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-4">React Complex Tree 拖拽测试</h1>
        
        <div className="grid grid-cols-2 gap-8">
          {/* ControlledTreeEnvironment - 手动处理状态 */}
          <div className="border rounded-lg p-4">
            <h2 className="text-lg font-semibold mb-2">ControlledTreeEnvironment</h2>
            <p className="text-sm text-muted-foreground mb-4">手动处理拖拽状态</p>
            
            <ControlledTreeEnvironment
              items={treeData}
              getItemTitle={item => item.data?.title || ''}
              viewState={{
                'tree-1': {
                  expandedItems,
                  selectedItems,
                  focusedItem
                }
              }}
              defaultInteractionMode={"click-arrow-to-expand" as any}
              canDragAndDrop={true}
              canDropOnFolder={true}
              canDropOnNonFolder={false}
              canReorderItems={true}
              canSearch={false}
              canRename={true}
              onExpandItem={(item) => {
                setExpandedItems([...expandedItems, item.index as string]);
              }}
              onCollapseItem={(item) => {
                setExpandedItems(expandedItems.filter(id => id !== item.index));
              }}
              onSelectItems={(ids) => {
                setSelectedItems(ids as string[]);
              }}
              onFocusItem={(item) => {
                setFocusedItem(item.index as string);
              }}
            >
              <Tree treeId="tree-1" rootItem="root" treeLabel="测试树" />
            </ControlledTreeEnvironment>
          </div>

          {/* 简单的拖拽测试 */}
          <div className="border rounded-lg p-4">
            <h2 className="text-lg font-semibold mb-2">原生 HTML5 拖拽测试</h2>
            <p className="text-sm text-muted-foreground mb-4">测试基础拖拽功能是否正常</p>
            
            <div className="space-y-2">
              {['Item 1', 'Item 2', 'Item 3', 'Item 4'].map((item) => (
                <div
                  key={item}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text', item);
                    console.log('拖拽开始:', item);
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const data = e.dataTransfer.getData('text');
                    console.log('放置:', data, '到', item);
                  }}
                  className="p-2 bg-muted rounded cursor-move hover:bg-accent"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 调试信息 */}
        <div className="mt-8 p-4 bg-muted rounded-lg">
          <h3 className="font-semibold mb-2">调试信息</h3>
          <div className="text-sm space-y-1">
            <p>请打开浏览器控制台查看拖拽事件日志</p>
            <p>测试步骤：</p>
            <ol className="list-decimal list-inside ml-4">
              <li>尝试拖拽左侧树中的文件和文件夹</li>
              <li>尝试将文件拖入文件夹</li>
              <li>尝试重新排序同级项目</li>
              <li>测试右侧的原生拖拽是否正常</li>
            </ol>
          </div>
        </div>

        {/* CSS 检查 */}
        <div className="mt-4 p-4 bg-muted rounded-lg">
          <h3 className="font-semibold mb-2">CSS 属性检查</h3>
          <div className="text-sm space-y-1">
            <p>-webkit-app-region: {getComputedStyle(document.body).getPropertyValue('-webkit-app-region') || 'none'}</p>
            <p>user-select: {getComputedStyle(document.body).getPropertyValue('user-select') || 'auto'}</p>
            <p>pointer-events: {getComputedStyle(document.body).getPropertyValue('pointer-events') || 'auto'}</p>
          </div>
        </div>
      </div>
    </div>
  );
}