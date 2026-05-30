import { useState, type ReactNode } from 'react'
import { APP_MODE } from '../lib/auth'
import { storageSet } from '../lib/storage'

const isCloud = APP_MODE === 'cloud'

const steps = [
  {
    title: '您是天机阁的老板',
    body: '整个江湖只有一个天机阁。你通过天机阁发布委托、了解全局和调度帮派。',
  },
  {
    title: '帮主负责帮派运转',
    body: '每支帮派有一个帮主。帮主负责拆委托、挑弟子、分派镖单、监控交付、解除阻塞，并在需要时发起议事堂。',
  },
  {
    title: '弟子可以扩充',
    body: isCloud
      ? "帮主会按委托挑选或创建弟子。默认跟随全局模型，必要时才给单个角色设置独立模型。"
      : "帮主会按委托挑选或创建弟子。默认跟随全局模型，必要时才给单个角色设置独立模型。",
  },
  {
    title: '一切优先本地执行',
    body: isCloud
      ? '当前帮派优先使用本地镖单、弟子、文件和记忆系统协作。'
      : '当前帮派优先使用本机镖单、弟子、文件和记忆系统协作。',
  },
  {
    title: '不会决定就开会',
    body: '当天机阁或帮主无法单独判断时，会邀请相关弟子开会，并生成完整议事堂记录。',
  },
  {
    title: '使用天机阁控制一切',
    body: '天机阁可以创建帮派、更新委托、启动或暂停帮主、管理镖单并传递消息。连接 Discord 后，也能继续通过本地接口做事。',
  },
]

function emphasizeRoleWords(text: string): ReactNode[] {
  return text.split(/(天机阁|帮主|弟子|议事堂)/g).map((part, index) => {
    if (/^(天机阁|帮主|弟子|议事堂)$/.test(part)) {
      return <span key={`role-${index}`} className="text-text-primary font-semibold">{part}</span>
    }
    return <span key={`text-${index}`}>{part}</span>
  })
}

interface WalkthroughModalProps {
  onClose: () => void
}

export function WalkthroughModal({ onClose }: WalkthroughModalProps): React.JSX.Element {
  const [step, setStep] = useState(0)
  const isLast = step === steps.length - 1

  function handleNext() {
    if (isLast) {
      storageSet('jianghu_walkthrough_seen', '1')
      onClose()
    } else {
      setStep(step + 1)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-md mx-4 p-8">
        <div className="flex gap-1.5 mb-6">
          {steps.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              className={`w-2.5 h-2.5 rounded-full transition-colors ${
                i === step ? 'bg-interactive' : 'bg-surface-tertiary hover:bg-border-primary'
              }`}
              aria-label={`步骤 ${i + 1}`}
            />
          ))}
        </div>

        <h2 className="text-2xl font-bold text-text-primary mb-3 leading-tight">
          {steps[step].title}
        </h2>
        <p className="text-text-muted text-base leading-relaxed mb-8">
          {emphasizeRoleWords(steps[step].body)}
        </p>

        <div className="flex justify-end gap-2">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-secondary border border-border-primary rounded-lg transition-colors"
            >
              返回
            </button>
          )}
          <button
            onClick={handleNext}
            className="px-5 py-2 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors"
          >
            {isLast ? '完成' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  )
}
