// 组织数据的数据层入口（S6a）。页面从这里取：
//   useOrgScope / useDealers / useIntegratedProjects / useProjects / useApps   列表（三态 Loadable）
//   useCurrentProject / whenProjectSet                                         当前项目（hjc-project 持久化、切换上报）
//   useOrgStat / useFrequentProjects                                           首页统计卡、常用项目
//   useCapabilities / capabilitiesOf / hasRooms / isStandalone                 按 app_code 派生的能力
//   useDealerPick / resolveDealerId                                            经销商默认值
//   projectsInGroup / projectsInGroups                                         按 Group.projectIds 取项目
export * from './types'
export { APP_CODE, capabilitiesOf, hasRooms, isStandalone, toAppCode, type Capabilities } from './capabilities'
export { dealerSections, type DealerSection, isOnlineEntity, joinScope, PLATFORM_DEALER, PLATFORM_DEALER_ID, withPlatformDealer, projectsInGroup, projectsInGroups, resolveCurrentProject, resolveDealerId } from './map'
export { orgKeys, SET_PROJECT_FAIL_TEXT, useApps, useCapabilities, useCurrentProject, useDealerPick, useDealers, useFrequentProjects, useIntegratedProjects, useOrgScope, useOrgStat, useProjects, useResetOnAccountChange, type CurrentProject, type FrequentProject, type Loadable, type OrgScope, type OrgStat, type SetProjectResult, whenProjectSet } from './hooks'
export { orgSource, type OrgSource, type ProjectFilter } from './sources'
