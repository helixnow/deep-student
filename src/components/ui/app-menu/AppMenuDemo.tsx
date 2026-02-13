/**
 * AppMenuDemo - 现代化菜单组件演示页面
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSub,
  AppMenuSubTrigger,
  AppMenuSubContent,
  AppMenuSeparator,
  AppMenuFooter,
  AppMenuSwitchItem,
  AppMenuOptionGroup,
} from './AppMenu';
import {
  Star,
  Link,
  Copy,
  Pencil,
  ArrowRight,
  Trash2,
  ExternalLink,
  PanelRight,
  Undo2,
  Download,
  Upload,
  Lock,
  MessageSquare,
  Languages,
  Clock,
  History,
  MoreHorizontal,
  ChevronDown,
  Settings,
  FileText,
  Folder,
  Plus,
  Search,
  Bell,
  User,
} from 'lucide-react';

const fontOptions = [
  { value: 'default', label: 'Ag', description: '默认' },
  { value: 'serif', label: 'Ag', description: '衬线体' },
  { value: 'mono', label: 'Ag', description: '等宽体' },
];

export function AppMenuDemo() {
  const { t } = useTranslation('app_menu');
  const [font, setFont] = useState('default');
  const [smallText, setSmallText] = useState(false);
  const [fullWidth, setFullWidth] = useState(false);
  const [lockPage, setLockPage] = useState(false);
  const [searchValue, setSearchValue] = useState('');

  return (
    <div className="p-8 space-y-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">{t('app_menu.demo.title', '现代化菜单演示')}</h1>
        <p className="text-muted-foreground mb-8">{t('app_menu.demo.description', '这是一个现代化的下拉菜单/右键菜单通用组件。')}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* 下拉菜单演示 - 基础版 */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">{t('app_menu.demo.dropdown_demo', '下拉菜单演示')}</h2>
            <div className="p-6 border border-border rounded-lg bg-card">
              <AppMenu>
                <AppMenuTrigger>
                  <button className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                    <MoreHorizontal className="w-4 h-4" />
                    <span>打开菜单</span>
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </AppMenuTrigger>
                <AppMenuContent width={260}>
                  <AppMenuGroup label={t('app_menu.groups.page', '页面')}>
                    <AppMenuItem icon={<Star />} shortcut="⌘⇧F">
                      {t('app_menu.actions.add_to_favorites', '添加到最爱')}
                    </AppMenuItem>
                    <AppMenuItem icon={<Link />} shortcut="⌥⌘L">
                      {t('app_menu.actions.copy_link', '拷贝链接')}
                    </AppMenuItem>
                    <AppMenuItem icon={<Copy />} shortcut="⌘D">
                      {t('app_menu.actions.duplicate', '创建副本')}
                    </AppMenuItem>
                    <AppMenuItem icon={<Pencil />} shortcut="⌘⇧R">
                      {t('app_menu.actions.rename', '重命名')}
                    </AppMenuItem>
                    <AppMenuItem icon={<ArrowRight />} shortcut="⌘⇧P">
                      {t('app_menu.actions.move_to', '移动到')}
                    </AppMenuItem>
                    <AppMenuItem icon={<Trash2 />} destructive>
                      {t('app_menu.actions.move_to_trash', '移至垃圾箱')}
                    </AppMenuItem>
                  </AppMenuGroup>

                  <AppMenuSeparator />

                  <AppMenuGroup>
                    <AppMenuItem icon={<ExternalLink />} shortcut="⌘⇧↵">
                      {t('app_menu.actions.open_in_new_tab', '在新选项卡中打开')}
                    </AppMenuItem>
                    <AppMenuItem icon={<PanelRight />} shortcut="⌥Click">
                      {t('app_menu.actions.open_in_sidebar', '在侧边预览中打开')}
                    </AppMenuItem>
                  </AppMenuGroup>

                  <AppMenuFooter>
                    {t('app_menu.footer.last_edited_by', { name: 'John', defaultValue: '上次由 John 编辑' })}
                    <br />
                    昨天 15:42
                  </AppMenuFooter>
                </AppMenuContent>
              </AppMenu>
            </div>
          </div>

          {/* 下拉菜单演示 - 高级版（带搜索和开关） */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">高级菜单（搜索+开关+选项）</h2>
            <div className="p-6 border border-border rounded-lg bg-card">
              <AppMenu>
                <AppMenuTrigger>
                  <button className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-secondary-foreground hover:bg-accent transition-colors">
                    <Settings className="w-4 h-4" />
                    <span>页面设置</span>
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </AppMenuTrigger>
                <AppMenuContent
                  width={280}
                  showSearch
                  searchPlaceholder={t('app_menu.search.placeholder', '搜索操作...')}
                  searchValue={searchValue}
                  onSearchChange={setSearchValue}
                >
                  {/* 字体选择器 */}
                  <AppMenuOptionGroup
                    options={fontOptions}
                    value={font}
                    onValueChange={setFont}
                  />

                  <AppMenuSeparator />

                  <AppMenuGroup>
                    <AppMenuItem icon={<Link />} shortcut="⌥⌘L">
                      {t('app_menu.actions.copy_link', '拷贝链接')}
                    </AppMenuItem>
                    <AppMenuItem icon={<Copy />} shortcut="⌘D">
                      {t('app_menu.actions.duplicate', '创建副本')}
                    </AppMenuItem>
                    <AppMenuItem icon={<ArrowRight />} shortcut="⌘⇧P">
                      {t('app_menu.actions.move_to', '移动到')}
                    </AppMenuItem>
                    <AppMenuItem icon={<Trash2 />} destructive>
                      {t('app_menu.actions.move_to_trash', '移至垃圾箱')}
                    </AppMenuItem>
                  </AppMenuGroup>

                  <AppMenuSeparator />

                  <AppMenuGroup>
                    <AppMenuSwitchItem
                      icon={<FileText />}
                      checked={smallText}
                      onCheckedChange={setSmallText}
                    >
                      {t('app_menu.switch.small_text', '小字号')}
                    </AppMenuSwitchItem>
                    <AppMenuSwitchItem
                      icon={<ArrowRight />}
                      checked={fullWidth}
                      onCheckedChange={setFullWidth}
                    >
                      {t('app_menu.switch.full_width', '全宽')}
                    </AppMenuSwitchItem>
                    <AppMenuItem icon={<Settings />}>
                      {t('app_menu.actions.customize_page', '自定义页面')}
                    </AppMenuItem>
                  </AppMenuGroup>

                  <AppMenuSeparator />

                  <AppMenuGroup>
                    <AppMenuSwitchItem
                      icon={<Lock />}
                      checked={lockPage}
                      onCheckedChange={setLockPage}
                    >
                      {lockPage ? t('app_menu.actions.unlock_page', '解锁页面') : t('app_menu.actions.lock_page', '锁定页面')}
                    </AppMenuSwitchItem>
                    <AppMenuItem icon={<MessageSquare />}>
                      {t('app_menu.actions.edit_suggestions', '编辑建议')}
                    </AppMenuItem>
                    <AppMenuSub>
                      <AppMenuSubTrigger icon={<Languages />}>
                        {t('app_menu.actions.translate', '翻译')}
                      </AppMenuSubTrigger>
                      <AppMenuSubContent>
                        <AppMenuItem>English</AppMenuItem>
                        <AppMenuItem>中文</AppMenuItem>
                        <AppMenuItem>日本語</AppMenuItem>
                        <AppMenuItem>한국어</AppMenuItem>
                        <AppMenuItem>Español</AppMenuItem>
                      </AppMenuSubContent>
                    </AppMenuSub>
                    <AppMenuItem icon={<Undo2 />} shortcut="⌘Z">
                      {t('app_menu.actions.undo', '撤消')}
                    </AppMenuItem>
                  </AppMenuGroup>

                  <AppMenuSeparator />

                  <AppMenuGroup>
                    <AppMenuItem icon={<Download />}>
                      {t('app_menu.actions.import', '导入')}
                    </AppMenuItem>
                    <AppMenuItem icon={<Upload />}>
                      {t('app_menu.actions.export', '导出')}
                    </AppMenuItem>
                  </AppMenuGroup>

                  <AppMenuSeparator />

                  <AppMenuGroup>
                    <AppMenuItem icon={<Clock />}>
                      {t('app_menu.actions.view_history', '所有更新和数据分析')}
                    </AppMenuItem>
                    <AppMenuItem icon={<History />} disabled>
                      {t('app_menu.actions.version_history', '版本历史')}
                    </AppMenuItem>
                  </AppMenuGroup>
                </AppMenuContent>
              </AppMenu>
            </div>
          </div>

          {/* 右键菜单演示 */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">{t('app_menu.demo.context_demo', '右键菜单演示')}</h2>
            <AppMenu mode="context">
              <AppMenuTrigger>
                <div className="p-12 border-2 border-dashed border-border rounded-lg bg-muted/30 flex items-center justify-center text-muted-foreground hover:border-primary/50 hover:bg-muted/50 transition-colors cursor-context-menu">
                  <span>{t('app_menu.demo.context_hint', '右键点击此区域')}</span>
                </div>
              </AppMenuTrigger>
              <AppMenuContent width={220}>
                <AppMenuGroup>
                  <AppMenuItem icon={<Plus />}>新建页面</AppMenuItem>
                  <AppMenuItem icon={<Folder />}>新建文件夹</AppMenuItem>
                </AppMenuGroup>
                <AppMenuSeparator />
                <AppMenuGroup>
                  <AppMenuItem icon={<Copy />} shortcut="⌘C">
                    复制
                  </AppMenuItem>
                  <AppMenuItem icon={<Pencil />}>
                    重命名
                  </AppMenuItem>
                  <AppMenuItem icon={<Trash2 />} destructive>
                    删除
                  </AppMenuItem>
                </AppMenuGroup>
              </AppMenuContent>
            </AppMenu>
          </div>

          {/* 特性列表 */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">{t('app_menu.demo.features.title', '组件特性')}</h2>
            <div className="p-6 border border-border rounded-lg bg-card space-y-3">
              <div className="flex items-center gap-3">
                <Search className="w-4 h-4 text-primary" />
                <span className="text-sm">{t('app_menu.demo.features.search', '可选搜索框')}</span>
              </div>
              <div className="flex items-center gap-3">
                <Star className="w-4 h-4 text-primary" />
                <span className="text-sm">{t('app_menu.demo.features.icons', '图标支持')}</span>
              </div>
              <div className="flex items-center gap-3">
                <Bell className="w-4 h-4 text-primary" />
                <span className="text-sm">{t('app_menu.demo.features.shortcuts', '快捷键显示')}</span>
              </div>
              <div className="flex items-center gap-3">
                <Folder className="w-4 h-4 text-primary" />
                <span className="text-sm">{t('app_menu.demo.features.groups', '分组和分隔线')}</span>
              </div>
              <div className="flex items-center gap-3">
                <ArrowRight className="w-4 h-4 text-primary" />
                <span className="text-sm">{t('app_menu.demo.features.submenu', '子菜单支持')}</span>
              </div>
              <div className="flex items-center gap-3">
                <Settings className="w-4 h-4 text-primary" />
                <span className="text-sm">{t('app_menu.demo.features.switch', '开关控件')}</span>
              </div>
              <div className="flex items-center gap-3">
                <FileText className="w-4 h-4 text-primary" />
                <span className="text-sm">{t('app_menu.demo.features.options', '选项组（类似字体选择器）')}</span>
              </div>
              <div className="flex items-center gap-3">
                <User className="w-4 h-4 text-primary" />
                <span className="text-sm">{t('app_menu.demo.features.footer', '底部元信息区域')}</span>
              </div>
              <div className="flex items-center gap-3">
                <Clock className="w-4 h-4 text-primary" />
                <span className="text-sm">{t('app_menu.demo.features.dark_light', '暗色/亮色主题自适应')}</span>
              </div>
            </div>
          </div>
        </div>

        {/* 使用示例代码 */}
        <div className="mt-12">
          <h2 className="text-lg font-semibold mb-4">使用示例</h2>
          <pre className="p-4 bg-muted rounded-lg overflow-x-auto text-sm">
{`import { 
  AppMenu, 
  AppMenuTrigger, 
  AppMenuContent, 
  AppMenuItem,
  AppMenuGroup,
  AppMenuSeparator
} from '@/components/ui/app-menu';
import { Star, Copy, Trash2 } from 'lucide-react';

function MyComponent() {
  return (
    <AppMenu>
      <AppMenuTrigger>
        <button>打开菜单</button>
      </AppMenuTrigger>
      <AppMenuContent>
        <AppMenuGroup label="操作">
          <AppMenuItem icon={<Star />} shortcut="⌘⇧F">
            添加到收藏
          </AppMenuItem>
          <AppMenuItem icon={<Copy />} shortcut="⌘D">
            复制
          </AppMenuItem>
        </AppMenuGroup>
        <AppMenuSeparator />
        <AppMenuItem icon={<Trash2 />} destructive>
          删除
        </AppMenuItem>
      </AppMenuContent>
    </AppMenu>
  );
}`}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default AppMenuDemo;
