import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from './shad/Command';
import {
  FileText,
  FolderPlus,
  Edit3,
  Maximize2,
  Minimize2,
  Plus,
  Search
} from 'lucide-react';

type NoteLite = { id: string; title?: string };

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  notes: NoteLite[];
  onOpenNote: (id: string) => void;
  onCreateNote: () => void;
  onCreateFolder: () => void;
  onRename: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onOpenAssistantSelection?: () => void;
  onOpenAssistantDocument?: () => void;
  onOpenAssistantLibrary?: () => void;
}

const CommandPalette: React.FC<Props> = ({
  open,
  onOpenChange,
  notes,
  onOpenNote,
  onCreateNote,
  onCreateFolder,
  onRename,
  onExpandAll,
  onCollapseAll,
  onOpenAssistantSelection,
  onOpenAssistantDocument,
  onOpenAssistantLibrary,
}) => {
  const { t } = useTranslation('command_palette');
  const [search, setSearch] = React.useState('');

  React.useEffect(() => {
    if (!open) {
      setSearch('');
    }
  }, [open]);

  const runCommand = React.useCallback((command: () => void) => {
    onOpenChange(false);
    command();
  }, [onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder={t('placeholder')}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>{t('no_results_simple')}</CommandEmpty>

        <CommandGroup heading={t('group_actions')}>
          <CommandItem onSelect={() => runCommand(onCreateNote)}>
            <Plus className="mr-2 h-4 w-4" />
            <span>{t('new_note')}</span>
            <CommandShortcut>N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(onCreateFolder)}>
            <FolderPlus className="mr-2 h-4 w-4" />
            <span>{t('new_folder')}</span>
            <CommandShortcut>⇧N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(onRename)}>
            <Edit3 className="mr-2 h-4 w-4" />
            <span>{t('rename')}</span>
            <CommandShortcut>F2</CommandShortcut>
          </CommandItem>

        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t('group_ai_assistant')}>
          <CommandItem onSelect={() => runCommand(onOpenAssistantSelection || (() => {}))}>
            <Search className="mr-2 h-4 w-4" />
            <span>{t('ai_on_selection')}</span>
            <CommandShortcut>⌘K S</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(onOpenAssistantDocument || (() => {}))}>
            <Search className="mr-2 h-4 w-4" />
            <span>{t('ai_on_document')}</span>
            <CommandShortcut>⌘K D</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(onOpenAssistantLibrary || (() => {}))}>
            <Search className="mr-2 h-4 w-4" />
            <span>{t('ai_on_library')}</span>
            <CommandShortcut>⌘K L</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t('group_view')}>
          <CommandItem onSelect={() => runCommand(onExpandAll)}>
            <Maximize2 className="mr-2 h-4 w-4" />
            <span>{t('expand_all')}</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(onCollapseAll)}>
            <Minimize2 className="mr-2 h-4 w-4" />
            <span>{t('collapse_all')}</span>
          </CommandItem>
        </CommandGroup>

        {notes.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('group_notes')}>
              {notes.slice(0, 20).map(note => (
                <CommandItem
                  key={note.id}
                  value={note.title || t('untitled')}
                  onSelect={() => runCommand(() => onOpenNote(note.id))}
                >
                  <FileText className="mr-2 h-4 w-4" />
                  <span className="truncate">{note.title || t('untitled')}</span>
                </CommandItem>
              ))}
              {notes.length > 20 && (
                <CommandItem disabled>
                  <Search className="mr-2 h-4 w-4" />
                  <span className="text-muted-foreground">
                    {t('more_notes', { count: notes.length - 20 })}
                  </span>
                </CommandItem>
              )}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
};

export default CommandPalette;
