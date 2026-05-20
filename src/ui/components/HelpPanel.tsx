import { APP_MODE } from '../lib/auth'

interface HelpPanelProps {
  onStartWalkthrough?: () => void
}

export function HelpPanel({ onStartWalkthrough }: HelpPanelProps): React.JSX.Element {
  return (
    <div className="p-4 space-y-4">
      {onStartWalkthrough && (
        <button
          onClick={onStartWalkthrough}
          className="w-full py-2 text-sm font-medium text-brand-700 bg-status-warning-bg hover:bg-status-warning-bg border border-amber-200 rounded-lg transition-colors"
        >
          快速入门指南 -&gt;
        </button>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">快速入门</h3>
          <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              <span className="font-medium text-text-secondary">创建临时帮派</span> - 一个围绕本次委托成立的项目组。任务完成后经验归档、履历更新。
            </p>
            <p>
              <span className="font-medium text-text-secondary">弟子</span> - 天机阁从帮派中选择或创建弟子，并把镖单分派给合适角色。
            </p>
            <p className="text-text-muted text-xs">
              示例：&quot;构建一个微型 SaaS 产品&quot; - 查看江湖如何拆解委托、分派镖单、推进执行和复盘。
            </p>
          </div>
        </div>

        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">工作原理</h3>
          <div className="bg-surface-secondary rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              <span className="font-medium text-interactive">
                {APP_MODE === 'cloud' ? '您的私有服务器。' : '100%本地化。'}
              </span>{' '}
              {APP_MODE === 'cloud'
                ? '数据库、弟子、藏经阁记忆 - 所有内容都由当前软件管理。'
                : '数据库、弟子、藏经阁记忆 - 所有内容都留在您的机器上。'}
            </p>
            <p>
              {APP_MODE === 'cloud'
                ? '托管服务器、SQLite数据库。'
                : <>服务器位于 <span className="font-mono text-text-secondary">localhost:4700</span>，SQLite数据库。</>
              }{' '}
              天机阁和弟子支持 Claude、Codex、MiMo、OpenAI 和 Anthropic API 模型。
            </p>
            <p className="text-xs text-text-muted">
              {APP_MODE === 'cloud'
                ? '本地服务 -&gt; SQLite -&gt; 模型选择'
                : <><span className="font-mono">zuzu serve</span> -&gt; SQLite -&gt; 模型选择</>
              }
            </p>
          </div>
        </div>

        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">核心概念</h3>
          <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-2 text-sm text-text-secondary flex-1">
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">天机阁</span>
              <span className="text-text-muted">- 中央调度层，负责分派镖单、监控进展和解除阻塞</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">弟子</span>
              <span className="text-text-muted">- 执行角色，可继承帮派模型或使用独立 API 模型</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">委托</span>
              <span className="text-text-muted">- 分层目标体系，决定江湖行动方向</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">功法</span>
              <span className="text-text-muted">- 可复用的能力模块</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-text-secondary shrink-0">藏经阁</span>
              <span className="text-text-muted">- 持久化知识图谱、经验和审计记录</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">议事堂协作</h3>
          <div className="bg-surface-secondary shadow-sm rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              当天机阁或弟子无法单独判断时，可以开启议事堂。相关角色会围绕问题给出观点、证据、阻塞点和下一步建议。
            </p>
            <p>
              查看<span className="font-medium text-text-secondary">议事堂</span>页面，打开记录可以看到类似群聊的讨论过程。
            </p>
          </div>
        </div>

        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-text-secondary mb-1">控制资源使用</h3>
          <div className="bg-status-warning-bg rounded-lg p-3 space-y-2 text-sm text-text-secondary leading-relaxed flex-1">
            <p>
              天机阁会按委托推进任务，并尽量控制资源消耗：
            </p>
            <div className="space-y-2">
              <div className="flex gap-2">
                <span className="font-medium text-brand-700 shrink-0">循环间隔</span>
                <span className="text-text-muted">- 循环之间的休眠时间。Pro版5-15分钟，Max版1-5分钟。</span>
              </div>
              <div className="flex gap-2">
                <span className="font-medium text-brand-700 shrink-0">最大回合数</span>
                <span className="text-text-muted">- 每个循环的工具调用次数。Pro版3-5次，Max版最多10次。</span>
              </div>
              <div className="flex gap-2">
                <span className="font-medium text-brand-700 shrink-0">静音时段</span>
                <span className="text-text-muted">- 阻塞一个时间窗口（例如22:00-08:00）让她休息。</span>
              </div>
            </div>
            <p className="text-xs text-text-muted pt-1 border-t border-amber-100">
              <span className="font-medium text-text-secondary">提示：</span> 在外观与设置中设置您的Claude订阅方案 - 系统会自动应用稳妥的默认值。
            </p>
            <p className="text-xs text-text-muted">
              <span className="font-medium text-text-secondary">没有元气预算？</span>{' '}
              使用按量付费的API模型（OpenAI或Anthropic）以精确控制成本。
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => window.open('https://github.com/zuzu-ai/room/issues/new')}
          className="w-full py-2 text-sm text-interactive hover:text-interactive-hover border border-border-primary hover:border-interactive rounded-lg transition-colors"
        >
          报告问题
        </button>
        <button
          onClick={() => window.open('https://github.com/zuzu-ai/room')}
          className="w-full py-2 text-sm text-status-warning hover:text-status-warning border border-yellow-200 hover:border-yellow-300 rounded-lg transition-colors"
        >
          GitHub Star
        </button>
        <button
          onClick={() => { window.location.href = 'mailto:hello@email.zuzu.ai' }}
          className="w-full py-2 text-sm text-text-muted hover:text-text-secondary border border-border-primary hover:border-border-primary rounded-lg transition-colors"
        >
          联系开发者
        </button>
      </div>
    </div>
  )
}
