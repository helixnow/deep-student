/**
 * 第 02 章「AI 对话与会话管理」：一扇对话窗口，会话是「《机器学习系统》第 3 章精读」——
 * 带 PDF 附件提问，回答里有资料检索块、PDF 页码引用徽章、内嵌章节导图和挖空卡。
 * 首屏停在首答播完、从对话开头看；之后访客可以继续追问（剧本续答 / 兜底回复）。
 */
import { CHAT_NAMESPACES, createChatScenePack, scrollToConversationTop, textReply } from '../data/chat/scene';

export default createChatScenePack({
  title: 'AI 对话',
  sessionId: 'demo-pdf-deepread',
  namespaces: CHAT_NAMESPACES,
  sourcePane: true,
  replies: [
    {
      keywords: ['参数服务器', 'allreduce', '聚合'],
      reply: textReply('**参数服务器**：worker 将梯度发送给参数服务器，由服务器完成聚合与参数更新，再向 worker 分发更新后的参数。[PDF@file_demo_mlsys:45]\n\n**AllReduce**：参与节点通过集合通信共同完成梯度归约，各节点获得相同的聚合结果，再更新各自的模型副本。\n\n两种方式都服务于数据并行训练。选择时可以结合网络拓扑、节点规模与故障处理需求，比较通信负载和运行效率。'),
    },
    {
      keywords: ['同步', '慢', 'straggler', '等待'],
      reply: textReply('同步 SGD 每一步都要等所有 worker 交回梯度，所以**每轮用时由最慢的节点决定**。[PDF@file_demo_mlsys:47]\n\n可以这样估算：单步时间 ≈ max(各 worker 计算时间) + 梯度通信时间。worker 越多，出现慢节点的概率越大，加速比就越偏离线性。\n\n缓解思路包括异步或有界延迟更新、备份 worker，以及第 52 页提到的减少通信量的方法。[PDF@file_demo_mlsys:52]'),
    },
    {
      keywords: ['压缩', '量化', '稀疏', '通信'],
      reply: textReply('梯度压缩的出发点是：数据并行训练里，每一步都要传输与模型同样大小的梯度，网络带宽很容易成为瓶颈。[PDF@file_demo_mlsys:52]\n\n- **量化**：把 32 位浮点梯度编码成更少的比特；\n- **稀疏化**：只传绝对值最大的一部分梯度，其余累积到下一轮。\n\n评估时要同时记录通信耗时、吞吐量和收敛情况——传得少了，但如果需要更多步才能收敛，总训练时间未必更短。'),
    },
  ],
  fallback: textReply('这段演示里的回答来自预设学习材料：你可以点正文里的 PDF 页码徽章、缩放章节导图、翻转下方的挖空卡，也可以换一个问题，比如「同步 SGD 为什么会被慢节点拖住？」\n\n在 Deep Student 桌面版里连上自己选的模型后，就能带着自己的教材、照片和笔记继续提问。'),
  // 海报：从对话开头看——带 PDF 附件的提问、思考与检索、带页码徽章的正文（导图和卡片往下滚）
  arrange(root) {
    scrollToConversationTop(root);
  },
});
