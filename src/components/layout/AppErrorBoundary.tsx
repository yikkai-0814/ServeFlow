import { Component, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/features/i18n/useTranslation'

/**
 * What stands between a rendering error and a blank screen.
 *
 * React unmounts the whole tree when a render throws and nothing catches it, which at a counter
 * means a white page with no way forward. This catches it and offers one.
 *
 * It sits outside the router and the auth provider, so that a failure in either is caught too,
 * and inside the language provider, because the message has to be translated. So the fallback
 * cannot use a router link, and "Back to start" is a plain link: a full page load is what clears
 * whatever went wrong.
 *
 * The error itself is never shown. It could name a document or an account, and it means nothing
 * to the person at the till. React still reports it to the console.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    return this.state.failed ? <AppErrorFallback /> : this.props.children
  }
}

function AppErrorFallback() {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background p-6 text-center"
    >
      <TriangleAlert className="size-10 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-2xl font-semibold tracking-tight">{t('app.errorTitle')}</h1>
      <p className="max-w-md text-muted-foreground">{t('app.errorBlurb')}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button
          size="lg"
          className="h-touch text-base"
          data-testid="error-reload"
          onClick={() => window.location.reload()}
        >
          {t('app.errorReload')}
        </Button>
        <Button asChild size="lg" variant="outline" className="h-touch text-base">
          <a href="/">{t('app.errorHome')}</a>
        </Button>
      </div>
    </div>
  )
}
