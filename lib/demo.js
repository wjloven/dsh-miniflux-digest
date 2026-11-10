/**
 * Offline demonstration feed. Used only when the plugin has no Miniflux
 * connection (or the user explicitly asks for the demo), so the reader,
 * digest, and recommendations can be exercised before credentials exist.
 * Sources here are fictional; nothing in this file quotes a real publication.
 */

const HOUR = 3_600_000

function iso(now, hoursAgo) {
  return new Date(now - hoursAgo * HOUR).toISOString()
}

const FEEDS = {
  lab: { id: 901, title: '示例 · 科技观察', category: { id: 91, title: '科技' } },
  eng: { id: 902, title: '示例 · 工程手记', category: { id: 91, title: '科技' } },
  product: { id: 903, title: '示例 · 产品笔记', category: { id: 92, title: '产品' } },
  media: { id: 904, title: '示例 · 信息饮食', category: { id: 93, title: '阅读' } },
  blog: { id: 905, title: '示例 · 独立博客', category: { id: 93, title: '阅读' } },
}

/** @param {number} [now] */
export function demoEntries(now = Date.now()) {
  return [
    {
      id: 9001,
      title: '推理成本一年下降 12 倍，省下来的钱去了哪里',
      url: 'https://example.com/demo/inference-cost',
      author: '示例作者',
      content: `<p>过去一年，主流模型的单位推理成本下降了约一个数量级。这不是某一次架构突破的结果，而是四件事叠加：更便宜的加速卡、更激进的量化、更成熟的批处理调度，以及缓存命中率的提升。</p>
<p>但成本下降并没有让账单同步下降。原因很直接：当单次调用变便宜，产品会把原来不敢做的功能打开。上下文从 8K 扩到 200K，Agent 从一次调用变成十几次调用，评估集从几百条扩到几万条。单位成本降了 12 倍，总消耗涨了 8 倍，净效果只是「勉强持平」。</p>
<h2>钱花在了三个地方</h2>
<p>把账单拆开看，大约六成花在长上下文，两成花在重试与工具调用，剩下的是评估和离线处理。长上下文之所以贵，不是因为输入单价，而是因为它让「把整份文档塞进去」变成了默认做法，而默认做法会迅速变成产品习惯。</p>
<p>真正有效的优化不是压单价，而是减少不必要的上下文：先检索再拼装、把稳定的前缀交给缓存、让模型自己决定要不要读全文。这三条在一个中等规模的团队里通常能省下 40% 以上，而且不影响答案质量。</p>
<p>结论有点反直觉：成本下降会先带来更多的消耗，然后才带来更便宜的产品。中间那段，是产品在试探能力边界。</p>`,
      published_at: iso(now, 3),
      reading_time: 9,
      status: 'unread',
      starred: false,
      feed: FEEDS.lab,
    },
    {
      id: 9002,
      title: '为什么我们把模型的上下文预算砍了一半',
      url: 'https://example.com/demo/context-budget',
      author: '示例作者',
      content: `<p>上季度我们把默认上下文预算从 64K 砍到 32K，客服工单没有变多，平均首字延迟下降了 38%。这个决定一开始遭到反对，理由是「信息越多越准」。实测并非如此。</p>
<p>我们做了个对照：同一批 400 个问题，一组塞满检索结果，一组只给最相关的 5 段。塞满的那组准确率反而低 6 个百分点，因为无关段落稀释了注意力，模型开始在边缘信息上编造关联。</p>
<h2>怎么判断一段上下文该不该进</h2>
<p>三个可操作的规则：它是否直接回答了问题的一半以上；它是否包含模型没有的专有事实；它是否会改变结论的方向。三条都不满足的内容，通常是噪音，不管它看起来多相关。</p>
<p>把这条规则产品化之后，我们的上下文预算下降，回答质量上升。模型能力在涨，但「少给一点、给准一点」仍然是工程上最便宜的收益。</p>`,
      published_at: iso(now, 7),
      reading_time: 5,
      status: 'unread',
      starred: false,
      feed: FEEDS.eng,
    },
    {
      id: 9003,
      title: '一个 RSS 重度用户的减法：从 320 个源到 40 个',
      url: 'https://example.com/demo/rss-subtraction',
      author: '示例作者',
      content: `<p>我曾经订阅 320 个源，每天未读 600 条，用三款阅读器轮换，仍然读不完。真正的问题不是工具，是我把「订阅」当成了「承诺」。</p>
<p>做减法的规则很简单：连续三个月没有一条让我改变想法或动手做事的源，删掉。不是它不好，是它对我的边际价值为零。删到 40 个之后，未读数从 600 降到 60，读完的比例从 8% 升到 70%。</p>
<h2>剩下的 40 个源怎么读</h2>
<p>分三层：每天必看的 5 个，每周扫一遍的 15 个，剩下的按主题检索。必看的 5 个不超过 20 分钟，扫读的 15 个用标题和首段判断，主题检索交给关键词。</p>
<p>信息过载的解药不是更快的阅读器，而是更少但更准的输入。工具应该帮你做减法，而不是帮你更快地堆积。</p>`,
      published_at: iso(now, 11),
      reading_time: 6,
      status: 'unread',
      starred: true,
      feed: FEEDS.media,
    },
    {
      id: 9004,
      title: '阅读器应该替你做什么，又不该替你做什么',
      url: 'https://example.com/demo/reader-scope',
      author: '示例作者',
      content: `<p>阅读器最容易做错的两件事：替你决定读什么，和替你假装读过了。前者把选择权拿走，后者把判断权拿走。</p>
<p>它该做的是降低摩擦：把正文抽干净、把排版调舒服、把未读组织成能一眼看懂的结构、让标记已读和收藏只花一次点击。它不该做的是替你总结到你不再点开原文，或者用推荐算法把你锁在一个越来越窄的循环里。</p>
<p>判断标准很朴素：用完这个工具之后，你读得更少但记得更多，还是读得更多但什么都记不住。</p>`,
      published_at: iso(now, 15),
      reading_time: 4,
      status: 'unread',
      starred: false,
      feed: FEEDS.blog,
    },
    {
      id: 9005,
      title: '订阅制产品的定价悖论：越便宜越难留住人',
      url: 'https://example.com/demo/pricing-paradox',
      author: '示例作者',
      content: `<p>低价订阅获客容易，留存难看。原因不在价格，而在价格决定的使用强度：每月 3 美元的用户不会认真配置，不会导入数据，不会形成习惯，于是三个月后自然流失。</p>
<p>我们在两个价格点上跑过同一批流量。高价组的激活率低 20%，但 90 天留存高 2.4 倍，因为付费本身是一次承诺，承诺会驱动用户完成配置。</p>
<h2>定价其实在筛选行为</h2>
<p>价格不是数字，是行为过滤器。它决定用户愿意投入多少时间，而投入的时间决定产品能否产生价值。把价格压到最低，等于把「愿意认真用」的用户和「随便试试」的用户混在一起，然后被后者的流失率拖垮。</p>
<p>所以涨价的正确姿势不是提价，而是提高门槛的同时提高承诺感：更明确的定位、更少的套餐、更容易看到的价值。</p>`,
      published_at: iso(now, 20),
      reading_time: 7,
      status: 'unread',
      starred: false,
      feed: FEEDS.product,
    },
    {
      id: 9006,
      title: '产品定价页的七个常见错误',
      url: 'https://example.com/demo/pricing-page',
      author: '示例作者',
      content: `<p>定价页不是价格表，是决策辅助。最常见的错误是把三个套餐做成九个功能勾选矩阵，让用户自己算。</p>
<p>另外六个：把最贵的套餐放在最左边、用「联系销售」遮住价格、把年付折扣写成百分比、缺一个「不确定选哪个」的引导、把 FAQ 放在页尾最深处、以及在移动端让对比表横向滚动。</p>
<p>改完之后最直接的指标不是转化率，而是支持工单里「我该选哪个」的比例。</p>`,
      published_at: iso(now, 27),
      reading_time: 3,
      status: 'unread',
      starred: false,
      feed: FEEDS.product,
    },
    {
      id: 9007,
      title: 'RSS 没有死，它只是回到了它该在的位置',
      url: 'https://example.com/demo/rss-return',
      author: '示例作者',
      content: `<p>过去十年每隔两年就有人说 RSS 死了。它确实不再是大众入口，但它从来没有停止工作：播客靠它分发， newsletters 靠它归档，内部知识库靠它聚合。</p>
<p>推荐流解决的是「我不知道看什么」，RSS 解决的是「我知道我要看什么，别让我漏掉」。前者是发现，后者是承诺。当信息噪音变大，承诺的价值反而上升。</p>
<p>所以 RSS 的复兴不会以「人人都用阅读器」的形式出现，而是以「每个认真获取信息的人都有一个自己的源清单」的形式出现。</p>`,
      published_at: iso(now, 33),
      reading_time: 4,
      status: 'unread',
      starred: false,
      feed: FEEDS.media,
    },
    {
      id: 9008,
      title: '把批处理调度做简单：一次队列重构的复盘',
      url: 'https://example.com/demo/batch-scheduler',
      author: '示例作者',
      content: `<p>我们的批处理调度器从 2019 年长到现在，有四种重试策略、三种优先级、两套限流。没人能完整说清一个任务为什么会排在某个位置。</p>
<h2>重构做了什么</h2>
<p>把「优先级」收敛成一个数字，把重试收敛成指数退避加一个上限，把限流从全局改成按依赖分组。删掉了 1400 行代码，P99 延迟下降 22%，最重要的是值班时能看懂日志了。</p>
<p>复盘得到的一条经验：调度系统的复杂度不来自功能，来自例外。每加一个例外，就多一个没人敢删的分支。</p>`,
      published_at: iso(now, 40),
      reading_time: 6,
      status: 'unread',
      starred: false,
      feed: FEEDS.eng,
    },
    {
      id: 9009,
      title: '写作是把想清楚这件事外包给纸',
      url: 'https://example.com/demo/writing',
      author: '示例作者',
      content: `<p>很多人以为写作是表达，其实写作是检验。你以为自己想清楚了，一动笔就发现论证中间有个洞。</p>
<p>所以写不出来往往不是语言问题，是思考没有完成。解决办法不是找更好的句子，而是把论点拆成三个必须成立的前提，逐个检查。</p>
<p>这也是为什么读完一篇结构清楚的长文会觉得「被说服」：不是修辞的力量，是前提都被摆出来了，你可以逐个反驳。</p>`,
      published_at: iso(now, 44),
      reading_time: 3,
      status: 'unread',
      starred: false,
      feed: FEEDS.blog,
    },
    {
      id: 9010,
      title: '本周值得注意的三个小工具',
      url: 'https://example.com/demo/tools',
      author: '示例作者',
      content: `<p>一个把网页转成干净 Markdown 的命令行工具；一个能对比两版文档差异的浏览器插件；一个把播客逐字稿对齐时间戳的小服务。</p>
<p>三个都不算新，但都在解决「把内容搬到我能处理的地方」这一个问题。工具的價值常常不在于能力，而在于减少一次复制粘贴。</p>`,
      published_at: iso(now, 50),
      reading_time: 2,
      status: 'unread',
      starred: false,
      feed: FEEDS.blog,
    },
  ]
}
