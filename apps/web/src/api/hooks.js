import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';

/**
 * Data hooks, one per backend resource. Lists keep the previous page while a
 * new one loads (no layout jump); mutations invalidate everything they touch.
 */

const useList = (key, path, params, options = {}) =>
  useQuery({ queryKey: [key, params], queryFn: ({ signal }) => api(path, { query: params, signal }), placeholderData: keepPreviousData, ...options });

// --- Reads ------------------------------------------------------------------
export const useMe = (options) => useQuery({ queryKey: ['me'], queryFn: () => api('/auth/me'), ...options });
export const useBusiness = () => useQuery({ queryKey: ['business'], queryFn: () => api('/business') });
export const useServices = (includeInactive = true) =>
  useQuery({ queryKey: ['services', includeInactive], queryFn: () => api('/business/services', { query: { includeInactive } }) });
export const useAiStatus = () => useQuery({ queryKey: ['aiStatus'], queryFn: () => api('/ai/status'), staleTime: 5 * 60e3 });

export const useSummary = (range) =>
  useQuery({ queryKey: ['summary', range], queryFn: () => api('/dashboard/summary', { query: { range } }), placeholderData: keepPreviousData });
export const useActivity = (limit = 15, category) =>
  useQuery({
    queryKey: ['activity', limit, category],
    queryFn: () => api('/dashboard/activity', { query: { limit, category } }),
    placeholderData: keepPreviousData,
  });
export const useAgents = (range) =>
  useQuery({
    queryKey: ['agents', range],
    queryFn: () => api('/dashboard/agents', { query: { range } }),
    placeholderData: keepPreviousData,
    // Agents work in the background: keep the panel fresh while it is visible.
    refetchInterval: 20_000,
  });
export const useInsights = () => useQuery({ queryKey: ['insights'], queryFn: () => api('/dashboard/insights') });

export const useLeads = (params) => useList('leads', '/leads', params);
export const useLead = (id) => useQuery({ queryKey: ['lead', id], queryFn: () => api(`/leads/${id}`), enabled: Boolean(id) });
export const useLeadEvents = (id, pageSize = 30) =>
  useQuery({ queryKey: ['leadEvents', id, pageSize], queryFn: () => api(`/leads/${id}/events`, { query: { pageSize } }), enabled: Boolean(id) });
export const useAgentRuns = (leadId) =>
  useQuery({ queryKey: ['agentRuns', leadId], queryFn: () => api(`/leads/${leadId}/agent-runs`, { query: { pageSize: 20 } }), enabled: Boolean(leadId) });
export const useAgentRun = (id, enabled) =>
  useQuery({ queryKey: ['agentRun', id], queryFn: () => api(`/agent-runs/${id}`), enabled: Boolean(id) && enabled });

export const useConversations = (params) => useList('conversations', '/conversations', params);
export const useAllAgentRuns = (params) => useList('agentRuns', '/agent-runs', params, { refetchInterval: 15_000 });
export const useMembers = () => useQuery({ queryKey: ['members'], queryFn: () => api('/business/members'), staleTime: 5 * 60e3 });
export const useFollowUps = (params) => useList('followUps', '/follow-ups', params);
export const useApprovals = (params) => useList('approvals', '/approvals', params);

// --- Writes -----------------------------------------------------------------
/** Everything derived from leads, messages and follow-ups. */
const LEAD_DATA_KEYS = ['leads', 'lead', 'leadEvents', 'agentRuns', 'conversations', 'followUps', 'approvals', 'summary', 'activity', 'agents', 'insights', 'recommendations', 'revenue', 'notifications'];

function useInvalidatingMutation(mutationFn, keys = LEAD_DATA_KEYS, options = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    ...options,
    onSuccess: async (...args) => {
      await Promise.all(keys.map((key) => qc.invalidateQueries({ queryKey: [key] })));
      await options.onSuccess?.(...args);
    },
  });
}

export const useCreateLead = () => useInvalidatingMutation((body) => api('/leads', { method: 'POST', body }));
export const useUpdateLead = (id) => useInvalidatingMutation((body) => api(`/leads/${id}`, { method: 'PATCH', body }));
export const useChangeStatus = (id) => useInvalidatingMutation((body) => api(`/leads/${id}/status`, { method: 'PATCH', body }));
export const useRunAgent = (id) => useInvalidatingMutation((body) => api(`/leads/${id}/agent-runs`, { method: 'POST', body }));
export const useSendReply = (id) => useInvalidatingMutation((body) => api(`/leads/${id}/messages`, { method: 'POST', body }));
export const useLogInbound = (id) => useInvalidatingMutation((body) => api(`/leads/${id}/messages/inbound`, { method: 'POST', body }));
export const useScheduleFollowUp = (leadId) =>
  useInvalidatingMutation((body) => api(`/leads/${leadId}/follow-ups`, { method: 'POST', body }));

export const useApprove = () => useInvalidatingMutation(({ id, ...body }) => api(`/approvals/${id}/approve`, { method: 'POST', body }));
export const useReject = () => useInvalidatingMutation(({ id, ...body }) => api(`/approvals/${id}/reject`, { method: 'POST', body }));
export const useCancelFollowUp = () =>
  useInvalidatingMutation(({ id, ...body }) => api(`/follow-ups/${id}/cancel`, { method: 'POST', body }));
export const useRescheduleFollowUp = () =>
  useInvalidatingMutation(({ id, ...body }) => api(`/follow-ups/${id}/reschedule`, { method: 'POST', body }));

export const useUpdateBusiness = () => useInvalidatingMutation((body) => api('/business', { method: 'PATCH', body }), ['business', 'me']);
export const useSaveService = () =>
  useInvalidatingMutation(
    ({ id, ...body }) => api(id ? `/business/services/${id}` : '/business/services', { method: id ? 'PUT' : 'POST', body }),
    ['services'],
  );
export const useArchiveService = () =>
  useInvalidatingMutation((id) => api(`/business/services/${id}`, { method: 'DELETE' }), ['services']);

export const useGenerateInsights = () =>
  useInvalidatingMutation((range) => api('/dashboard/insights', { method: 'POST', body: { range } }), ['insights', 'agents']);

// --- Website intelligence & knowledge ------------------------------------------
export const useWebsite = () =>
  useQuery({
    queryKey: ['website'],
    queryFn: () => api('/website'),
    // Poll while an analysis is running.
    refetchInterval: (q) => (['QUEUED', 'FETCHING', 'ANALYZING'].includes(q.state.data?.website?.status) ? 2000 : false),
  });
export const useKnowledge = (params) => useQuery({ queryKey: ['knowledge', params], queryFn: () => api('/knowledge', { query: params }) });
export const useConnectWebsite = () => useInvalidatingMutation((url) => api('/website', { method: 'POST', body: { url } }), ['website', 'knowledge']);
export const useCreateKnowledge = () => useInvalidatingMutation((body) => api('/knowledge', { method: 'POST', body }), ['knowledge', 'website']);
export const useUpdateKnowledge = () => useInvalidatingMutation(({ id, ...body }) => api(`/knowledge/${id}`, { method: 'PATCH', body }), ['knowledge', 'website']);
export const useDeleteKnowledge = () => useInvalidatingMutation((id) => api(`/knowledge/${id}`, { method: 'DELETE' }), ['knowledge', 'website']);
export const usePromoteKnowledge = () =>
  useInvalidatingMutation(({ id, ...body }) => api(`/knowledge/${id}/promote`, { method: 'POST', body }), ['knowledge', 'website', 'services']);

// --- Autonomy & appointments -------------------------------------------------------
export const useAutonomy = () => useQuery({ queryKey: ['autonomy'], queryFn: () => api('/autonomy') });
export const useUpdateAutonomy = () => useInvalidatingMutation((body) => api('/autonomy', { method: 'PUT', body }), ['autonomy']);
export const useAppointments = (params) => useQuery({ queryKey: ['appointments', params], queryFn: () => api('/appointments', { query: params }), placeholderData: keepPreviousData });
export const useSlots = (leadId, durationMinutes, enabled) =>
  useQuery({ queryKey: ['slots', leadId, durationMinutes], queryFn: () => api(`/leads/${leadId}/appointments/slots`, { query: { durationMinutes } }), enabled });
const APPT_KEYS = [...LEAD_DATA_KEYS, 'appointments', 'slots'];
export const useBookAppointment = (leadId) => useInvalidatingMutation((body) => api(`/leads/${leadId}/appointments`, { method: 'POST', body }), APPT_KEYS);
export const useRescheduleAppointment = () => useInvalidatingMutation(({ id, ...body }) => api(`/appointments/${id}`, { method: 'PATCH', body }), APPT_KEYS);
export const useCancelAppointment = () => useInvalidatingMutation(({ id, ...body }) => api(`/appointments/${id}/cancel`, { method: 'POST', body }), APPT_KEYS);
export const useAppointmentOutcome = () => useInvalidatingMutation(({ id, status }) => api(`/appointments/${id}/outcome`, { method: 'POST', body: { status } }), APPT_KEYS);

// --- Revenue, recommendations, notifications ------------------------------------
export const useRevenue = (range) => useQuery({ queryKey: ['revenue', range], queryFn: () => api('/revenue', { query: { range } }), placeholderData: keepPreviousData });
export const useRecommendations = () => useQuery({ queryKey: ['recommendations'], queryFn: () => api('/recommendations') });
export const useRefreshRecommendations = () => useInvalidatingMutation(() => api('/recommendations/refresh', { method: 'POST' }), ['recommendations', 'notifications']);
export const useResolveRecommendation = () =>
  useInvalidatingMutation(({ id, action }) => api(`/recommendations/${id}/${action}`, { method: 'POST' }), ['recommendations']);
export const useNotifications = (params) => useQuery({ queryKey: ['notifications', params], queryFn: () => api('/notifications', { query: params }) });
export const useUnreadCount = () => useQuery({ queryKey: ['notifications', 'unread-count'], queryFn: () => api('/notifications/unread-count'), refetchInterval: 60_000 });
export const useMarkRead = () => useInvalidatingMutation((id) => api(`/notifications/${id}/read`, { method: 'POST' }), ['notifications']);
export const useMarkAllRead = () => useInvalidatingMutation(() => api('/notifications/read-all', { method: 'POST' }), ['notifications']);

// --- Simulator & integrations ------------------------------------------------------
export const useSimulate = () => useMutation({ mutationFn: (body) => api('/simulations', { method: 'POST', body }) });
export const useIntegrations = () => useQuery({ queryKey: ['integrations'], queryFn: () => api('/integrations') });
export const useTestIntegration = () => useInvalidatingMutation((provider) => api(`/integrations/${provider}/test`, { method: 'POST' }), ['integrations']);
export const useConnectGoDaddy = () => useInvalidatingMutation((token) => api('/integrations/godaddy_domains', { method: 'PUT', body: { token } }), ['integrations']);
export const useRotateWebhook = () => useInvalidatingMutation(() => api('/integrations/website_webhook/rotate', { method: 'POST' }), ['integrations']);
export const useDisconnectIntegration = () => useInvalidatingMutation((provider) => api(`/integrations/${provider}`, { method: 'DELETE' }), ['integrations']);
