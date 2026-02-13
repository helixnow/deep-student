export const invoke = async (command: string, _payload?: Record<string, unknown>) => {
  switch (command) {
    case 'get_all_custom_templates':
      return [];
    case 'get_default_template_id':
      return null;
    case 'import_builtin_templates':
    case 'update_custom_template':
    default:
      return null;
  }
};

export default { invoke };







