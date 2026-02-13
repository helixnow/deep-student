/**
 * Template Stream Parser
 * 
 * 解析混合了自然语言和 XML Action Block 的流式响应。
 * 
 * 协议：
 * 自然语言直接输出。
 * <action type="...">content</action> 被解析为 Action。
 * 支持流式解析，能够处理被截断的标签。
 */

export interface TemplateAction {
  type: string;
  content: string;
  status: 'streaming' | 'completed';
}

export interface ParseResult {
  textDelta: string; // 用于追加到对话气泡的文本
  actionUpdate: TemplateAction | null; // 当前正在更新的 Action
}

export class TemplateStreamParser {
  private buffer: string = '';
  private inAction: boolean = false;
  private currentActionType: string | null = null;
  private currentActionContent: string = '';

  /**
   * 解析输入的流式 Chunk
   * @param chunk 新收到的字符串片段
   */
  parse(chunk: string): ParseResult {
    this.buffer += chunk;
    let textDelta = '';
    let actionUpdate: TemplateAction | null = null;

    while (this.buffer.length > 0) {
      if (!this.inAction) {
        // 寻找 <action
        const tagStart = this.buffer.indexOf('<action');
        if (tagStart === -1) {
          // 没有 <action，但也可能是标签的一半 (例如 "<act")
          // 只有当 buffer 结尾不包含 '<' 或者是完整的非 action 文本时才能安全输出
          // 简单起见，我们保留最后几个字符以防截断
          const lastOpen = this.buffer.lastIndexOf('<');
          if (lastOpen !== -1 && this.buffer.length - lastOpen < 20) {
            // 可能是标签开头，暂存 lastOpen 之后的内容
            textDelta += this.buffer.substring(0, lastOpen);
            this.buffer = this.buffer.substring(lastOpen);
            break; // 等待更多数据
          } else {
            // 安全输出所有
            textDelta += this.buffer;
            this.buffer = '';
          }
        } else {
          // 发现了 <action
          // 先把前面的文本输出
          if (tagStart > 0) {
            textDelta += this.buffer.substring(0, tagStart);
            this.buffer = this.buffer.substring(tagStart);
          }
          
          // 检查是否是完整的起始标签
          const tagEnd = this.buffer.indexOf('>');
          if (tagEnd === -1) {
            break; // 标签未闭合，等待
          }

          // 解析标签属性
          const tagContent = this.buffer.substring(0, tagEnd + 1); // <action type="...">
          const typeMatch = tagContent.match(/type=["']([^"']+)["']/);
          
          if (typeMatch) {
            this.inAction = true;
            this.currentActionType = typeMatch[1];
            this.currentActionContent = '';
            this.buffer = this.buffer.substring(tagEnd + 1);
            
            // 立即返回一个空的 streaming action，通知 UI 开始
            actionUpdate = {
              type: this.currentActionType!,
              content: '',
              status: 'streaming'
            };
          } else {
            // 无效标签，当作普通文本输出
            textDelta += tagContent;
            this.buffer = this.buffer.substring(tagEnd + 1);
          }
        }
      } else {
        // 在 Action 内部，寻找结束标签 </action>
        const closeTag = '</action>';
        const closeIndex = this.buffer.indexOf(closeTag);

        if (closeIndex === -1) {
          // 未找到结束标签
          // 检查 buffer 结尾是否是结束标签的一部分
          // 例如 "</act"
          let safeEnd = this.buffer.length;
          const lastOpen = this.buffer.lastIndexOf('<');
          if (lastOpen !== -1) {
             // 检查是否匹配 </action> 的前缀
             const potentialTag = this.buffer.substring(lastOpen);
             if (closeTag.startsWith(potentialTag)) {
               safeEnd = lastOpen;
             }
          }

          const contentChunk = this.buffer.substring(0, safeEnd);
          this.currentActionContent += contentChunk;
          this.buffer = this.buffer.substring(safeEnd);

          if (contentChunk.length > 0) {
             actionUpdate = {
               type: this.currentActionType!,
               content: this.currentActionContent, // 这里其实可以是全量 content 或 delta，Store 处理全量比较简单
               status: 'streaming'
             };
          }
          
          if (this.buffer.length > 0 && safeEnd === this.buffer.length) {
             // buffer 还有剩余但那是潜在标签的一部分，跳出等待
             break; 
          } else if (this.buffer.length > 0) {
             // 理论上走到这 buffer 应该是潜在标签前缀
             break;
          }

        } else {
          // 找到了结束标签
          const contentChunk = this.buffer.substring(0, closeIndex);
          this.currentActionContent += contentChunk;
          
          // Action 完成
          actionUpdate = {
            type: this.currentActionType!,
            content: this.currentActionContent,
            status: 'completed'
          };

          // 重置状态
          this.inAction = false;
          this.currentActionType = null;
          this.currentActionContent = '';
          this.buffer = this.buffer.substring(closeIndex + closeTag.length);
        }
      }
    }

    return { textDelta, actionUpdate };
  }

  /**
   * 重置解析器状态
   */
  reset() {
    this.buffer = '';
    this.inAction = false;
    this.currentActionType = null;
    this.currentActionContent = '';
  }
}

