import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex flex-col h-screen bg-surface-primary items-center justify-center px-4">
        <div className="max-w-sm w-full text-center flex flex-col items-center space-y-4">
          <h1 className="text-lg font-bold text-text-primary">页面出错了</h1>
          <p className="text-sm text-text-muted">
            {this.state.error?.message || '发生了一个未预期的问题。'}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="text-sm px-4 py-2 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors"
          >
            刷新页面
          </button>
          <button
            onClick={() => window.open('https://github.com/Wang-snail/jianghu/issues/new')}
            className="text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            提交问题
          </button>
        </div>
      </div>
    )
  }
}
