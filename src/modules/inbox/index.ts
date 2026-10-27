// PUBLIC API of the inbox module (staff WhatsApp inbox, Phase 06). Pages and routes use ONLY these: authorization is checked
// inside each function (never in the UI), every query is organization-scoped, and nothing here sends to Meta. Sending a reply
// is the messaging module's job (POST /api/conversations/{id}/messages); this module only reads and manages the workflow.
export { listConversations, listInboxAccounts, type InboxDeps } from "./list";
export { INBOX_DEFAULTS, readInboxConfig, type InboxConfig } from "./config";
export { getConversationDetail } from "./detail";
export { listMessages } from "./timeline";
export {
  assignConversation,
  changeConversationStatus,
  listAssignees,
  type AssignmentResult,
  type StatusChangeResult,
} from "./workflow";
export { markMessagesSeen, type SeenResult } from "./read-state";
export { createNote, listNotes } from "./notes";
export { addContactTag, createTag, listAvailableTags, removeContactTag } from "./tags";
export { createQuickReply, listQuickReplies, updateQuickReply } from "./quick-replies";
export { InboxConflictError } from "./errors";
export {
  INBOX_VIEWS,
  type AssigneeOption,
  type AssigneeView,
  type BotIndicator,
  type BotNoticeOutcome,
  type BotSessionStatus,
  type ContactLabel,
  type ConversationDetail,
  type ConversationListItem,
  type ConversationPage,
  type ConversationStatus,
  type DeliveryView,
  type HistoryEntry,
  type InboxView,
  type MessagePage,
  type NotePage,
  type NoteView,
  type QuickReplyView,
  type ReplyState,
  type TagView,
  type TimelineMessage,
} from "./types";
