// Ordinals match the pinned SDK and keep offline Replay independent of npm installs.
const offlineEventTypes = Object.freeze({ CLICK_EVENT: 0, SCROLL_TOP_EVENT: 1, SCROLL_BOTTOM_EVENT: 2 });

export function mapEvenHubInput(event, OsEventTypeList = offlineEventTypes) {
  if (!event || event.audioEvent || event.menuItemClickEvent) return null;
  const envelope = event.textEvent ?? event.listEvent;
  let eventType;
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && !event.sysEvent) {
    eventType = envelope.eventType ?? OsEventTypeList.CLICK_EVENT;
  } else if (!envelope && event.sysEvent) {
    const { eventType: systemType, eventSource, imuData, systemExitReasonCode } = event.sysEvent;
    // ProtoJSON can omit CLICK_EVENT (zero) while retaining the touch source.
    eventType = systemType;
    if (systemType === undefined && [1, 2, 3].includes(eventSource) &&
        imuData == null && systemExitReasonCode == null) {
      eventType = OsEventTypeList.CLICK_EVENT;
    }
  }
  switch (eventType) {
    case OsEventTypeList.CLICK_EVENT: return { type: 'click', source: 'g2' };
    case OsEventTypeList.SCROLL_TOP_EVENT: return { type: 'scroll', direction: -1 };
    case OsEventTypeList.SCROLL_BOTTOM_EVENT: return { type: 'scroll', direction: 1 };
    default: return null;
  }
}
