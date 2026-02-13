/**
 * 测试场景配置
 */

import { 
  Trash2, Zap, StopCircle, Edit3, Save 
} from 'lucide-react';
import { TestScenarioConfig } from './types';

export const SCENARIO_CONFIGS: TestScenarioConfig[] = [
  {
    id: 'complete-flow',
    name: 'dev:save_test.scenarios.complete_flow.name',
    description: 'dev:save_test.scenarios.complete_flow.description',
    icon: Zap,
    color: 'hsl(var(--primary))',
    steps: [
      'dev:save_test.steps.send_msg1',
      'dev:save_test.steps.edit_resend_msg2',
      'dev:save_test.steps.send_msg3',
      'dev:save_test.steps.save_to_library',
      'dev:save_test.steps.navigate_library',
      'dev:save_test.steps.send_msg4',
      'dev:save_test.steps.send_msg5',
      'dev:save_test.steps.send_msg6',
      'dev:save_test.steps.delete_msg5',
      'dev:save_test.steps.reload_verify',
    ],
    implemented: true,
  },
  {
    id: 'delete',
    name: 'dev:save_test.scenarios.delete.name',
    description: 'dev:save_test.scenarios.delete.description',
    icon: Trash2,
    color: 'hsl(var(--danger))',
    steps: [
      'dev:save_test.steps.preflight_check',
      'dev:save_test.steps.load_data',
      'dev:save_test.steps.verify_initial',
      'dev:save_test.steps.delete_message',
      'dev:save_test.steps.verify_save',
      'dev:save_test.steps.reload_verify',
      'dev:save_test.steps.integrity_check',
    ],
    implemented: true,
  },
  {
    id: 'stream-complete',
    name: 'dev:save_test.scenarios.stream_complete.name',
    description: 'dev:save_test.scenarios.stream_complete.description',
    icon: Zap,
    color: 'hsl(var(--success))',
    steps: [
      'dev:save_test.steps.preflight_check',
      'dev:save_test.steps.load_data',
      'dev:save_test.steps.send_message',
      'dev:save_test.steps.wait_stream',
      'dev:save_test.steps.verify_save',
      'dev:save_test.steps.reload_verify',
      'dev:save_test.steps.integrity_check',
    ],
    implemented: true,
  },
  {
    id: 'manual-stop',
    name: 'dev:save_test.scenarios.manual_stop.name',
    description: 'dev:save_test.scenarios.manual_stop.description',
    icon: StopCircle,
    color: 'hsl(var(--warning))',
    steps: [
      'dev:save_test.steps.preflight_check',
      'dev:save_test.steps.load_data',
      'dev:save_test.steps.send_message',
      'dev:save_test.steps.manual_stop',
      'dev:save_test.steps.verify_save',
      'dev:save_test.steps.reload_verify',
      'dev:save_test.steps.integrity_check',
    ],
    implemented: true,
  },
  {
    id: 'edit-resend',
    name: 'dev:save_test.scenarios.edit_resend.name',
    description: 'dev:save_test.scenarios.edit_resend.description',
    icon: Edit3,
    color: 'hsl(var(--info))',
    steps: [
      'dev:save_test.steps.preflight_check',
      'dev:save_test.steps.load_data',
      'dev:save_test.steps.edit_message',
      'dev:save_test.steps.resend_message',
      'dev:save_test.steps.wait_stream',
      'dev:save_test.steps.verify_save',
      'dev:save_test.steps.reload_verify',
      'dev:save_test.steps.integrity_check',
    ],
    implemented: true,
  },
  {
    id: 'manual-save',
    name: 'dev:save_test.scenarios.manual_save.name',
    description: 'dev:save_test.scenarios.manual_save.description',
    icon: Save,
    color: 'hsl(var(--primary))',
    steps: [
      'dev:save_test.steps.preflight_check',
      'dev:save_test.steps.load_data',
      'dev:save_test.steps.trigger_save',
      'dev:save_test.steps.verify_save',
      'dev:save_test.steps.reload_verify',
      'dev:save_test.steps.integrity_check',
    ],
    implemented: true,
  },
];

