// TanStack Query 的统一默认值与查询定义。页面接入在 S6 以后逐页进行。
import { QueryClient, queryOptions } from '@tanstack/react-query'
import { callCtrl, type CtrlQuery, type CtrlType } from './ctrl'
import { isApiError, isRetryable } from './errors'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 读请求：网络/超时/服务器错误自动重试 1 次；未认证、无权限、控制屏离线、ctrl 业务错误不重试
        retry: (failureCount, error) => failureCount < 1 && isRetryable(error),
        refetchOnWindowFocus: false,
        staleTime: 10_000,
        // 轮询（refetchInterval）按页面设置；标签页不可见时 TanStack 默认暂停
      },
      // 写请求一律不自动重试
      mutations: { retry: false },
    },
  })
}

export const queryKeys = {
  ctrl: (type: CtrlType, projectId: string, query?: unknown) => ['ctrl', type, projectId, query ?? null] as const,
}

/** ctrl 读消息的查询定义，例：useQuery(ctrlQuery(205, projectId)) */
export function ctrlQuery<T extends CtrlType>(type: T, projectId: string, query?: Partial<CtrlQuery<T>>) {
  return queryOptions({
    queryKey: queryKeys.ctrl(type, projectId, query),
    queryFn: ({ signal }) => callCtrl(type, projectId, query, { signal }),
    enabled: !!projectId,
  })
}

/** 控制屏离线是常态，不当作需要弹提示的异常 */
export const isOfflineError = (e: unknown) => isApiError(e) && e.kind === 'unavailable'
