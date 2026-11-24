// 组织数据的数据层入口（S6a）。页面从这里取：
//   useOrgScope / useDealers / useIntegratedProjects / useProjects / useApps   列表（三态 Loadable）
//   useCurrentProject                                                          当前项目（hjc-project 持久化）
//   useCapabilities / capabilitiesOf / hasRooms / isStandalone                 按 app_code 派生的能力
//   useDealerPick / resolveDealerId                                            经销商默认值
//   projectsInGroup / projectsInGroups                                         按 Group.projectIds 取项目
export * from './types'
export { APP_CODE, capabilitiesOf, hasRooms, isStandalone, toAppCode, type Capabilities } from './capabilities'
export { isOnlineEntity, joinScope, projectsInGroup, projectsInGroups, resolveCurrentProject, resolveDealerId } from './map'
export { orgKeys, useApps, useCapabilities, useCurrentProject, useDealerPick, useDealers, useIntegratedProjects, useOrgScope, useProjects, useResetOrgOnSignOut, type CurrentProject, type Loadable } from './hooks'
export { orgSource, type OrgSource, type ProjectFilter } from './sources'
