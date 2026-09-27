import { controlNotificationKey, formatControlNoticeMessage } from "../runs/shared/subagent-control.js";
export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";
export function controlNoticeTarget(details) {
    return details.childIntercomTarget;
}
export function formatSubagentControlNotice(details, content) {
    return details.noticeText ?? content ?? formatControlNoticeMessage(details.event, controlNoticeTarget(details));
}
function deliverControlNotice(input) {
    const childIntercomTarget = controlNoticeTarget(input.details);
    const key = controlNotificationKey(input.details.event, childIntercomTarget);
    if (input.visibleControlNotices.has(key))
        return;
    input.visibleControlNotices.add(key);
    const noticeText = input.details.noticeText ?? formatControlNoticeMessage(input.details.event, childIntercomTarget);
    input.pi.sendMessage({
        customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
        content: noticeText,
        display: true,
        details: { ...input.details, childIntercomTarget, noticeText },
    }, { triggerTurn: input.details.source === "async" });
}
export function handleSubagentControlNotice(input) {
    if (!input.details?.event || input.details.event.type === "active_long_running")
        return;
    if (input.details.source === "foreground") {
        // A foreground tool blocks Pi from displaying this message. The run can
        // finish before Pi flushes it, and queued messages cannot be withdrawn.
        // Foreground control remains available through the live tool and fleet state.
        return;
    }
    deliverControlNotice(input);
}
//# sourceMappingURL=control-notices.js.map