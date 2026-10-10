import { createAttachmentsPanel } from './attachments.js';

/** Parent and names come only from the caller's authorized certification/employee lists. */
export function createCertificationAttachmentsPanel({ certification, employees, isCurrent, onClose }) {
  return createAttachmentsPanel({
    entity: 'certification-attachments', parentRecord: certification, employees, isCurrent, onClose,
  });
}
