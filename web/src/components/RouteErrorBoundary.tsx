import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** 路由级错误边界：局部崩溃不出白屏，可一键回 Dashboard */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留痕；接 Sentry/自建上报时在此扩展
    console.error('Route render error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div role="alert" className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
          <h1 className="text-lg font-semibold">页面出错了</h1>
          <p className="max-w-md text-sm text-muted-foreground">{this.state.error.message}</p>
          <a
            href="/dashboard"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            返回 Dashboard
          </a>
        </div>
      );
    }
    return this.props.children;
  }
}
