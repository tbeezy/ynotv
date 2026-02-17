import { useEffect, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import './Modal.css';

export type ModalType = 'info' | 'confirm' | 'error' | 'success';

interface ModalProps {
    isOpen: boolean;
    title: string;
    message: string;
    type?: ModalType;
    confirmText?: string;
    cancelText?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
    onClose?: () => void;
}

export function Modal({
    isOpen,
    title,
    message,
    type = 'info',
    confirmText = 'OK',
    cancelText = 'Cancel',
    onConfirm,
    onCancel,
    onClose,
}: ModalProps) {
    const handleClose = useCallback(() => {
        onClose?.();
        onCancel?.();
    }, [onClose, onCancel]);

    const handleConfirm = useCallback(() => {
        onConfirm?.();
        onClose?.();
    }, [onConfirm, onClose]);

    // Handle escape key
    useEffect(() => {
        if (!isOpen) return;

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                handleClose();
            }
        };

        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [isOpen, handleClose]);

    // Handle enter key for confirm
    useEffect(() => {
        if (!isOpen || type !== 'confirm') return;

        const handleEnter = (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                handleConfirm();
            }
        };

        document.addEventListener('keydown', handleEnter);
        return () => document.removeEventListener('keydown', handleEnter);
    }, [isOpen, type, handleConfirm]);

    if (!isOpen) return null;

    const icon = getIconForType(type);

    return createPortal(
        <div className="modal-overlay" onClick={handleClose}>
            <div className={`modal-container modal-type-${type}`} onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div className={`modal-icon modal-icon-${type}`}>
                        {icon}
                    </div>
                    <h3 className="modal-title">{title}</h3>
                    <button className="modal-close-btn" onClick={handleClose} aria-label="Close">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="modal-body">
                    <p className="modal-message">{message}</p>
                </div>

                <div className="modal-footer">
                    {type === 'confirm' ? (
                        <>
                            <button
                                className="modal-btn modal-btn-secondary"
                                onClick={handleClose}
                            >
                                {cancelText}
                            </button>
                            <button
                                className="modal-btn modal-btn-primary"
                                onClick={handleConfirm}
                                autoFocus
                            >
                                {confirmText}
                            </button>
                        </>
                    ) : (
                        <button
                            className="modal-btn modal-btn-primary"
                            onClick={handleConfirm || handleClose}
                            autoFocus
                        >
                            {confirmText}
                        </button>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}

function getIconForType(type: ModalType): React.ReactNode {
    switch (type) {
        case 'confirm':
            return (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v8M8 12h8" />
                </svg>
            );
        case 'error':
            return (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
            );
        case 'success':
            return (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="9 12 12 15 17 9" />
                </svg>
            );
        default:
            return (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
            );
    }
}

// Hook for using modals

interface ModalState {
    isOpen: boolean;
    title: string;
    message: string;
    type: ModalType;
    confirmText: string;
    cancelText: string;
    onConfirm?: () => void;
    onCancel?: () => void;
}

const initialState: ModalState = {
    isOpen: false,
    title: '',
    message: '',
    type: 'info',
    confirmText: 'OK',
    cancelText: 'Cancel',
};

export function useModal() {
    const [state, setState] = useState<ModalState>(initialState);

    const showModal = useCallback((options: Omit<ModalState, 'isOpen'>) => {
        setState({ ...options, isOpen: true });
    }, []);

    const showInfo = useCallback((title: string, message: string, confirmText = 'OK') => {
        setState({
            ...initialState,
            isOpen: true,
            title,
            message,
            type: 'info',
            confirmText,
        });
    }, []);

    const showSuccess = useCallback((title: string, message: string, confirmText = 'OK') => {
        setState({
            ...initialState,
            isOpen: true,
            title,
            message,
            type: 'success',
            confirmText,
        });
    }, []);

    const showError = useCallback((title: string, message: string, confirmText = 'OK') => {
        setState({
            ...initialState,
            isOpen: true,
            title,
            message,
            type: 'error',
            confirmText,
        });
    }, []);

    const showConfirm = useCallback((
        title: string,
        message: string,
        onConfirm: () => void,
        onCancel?: () => void,
        confirmText = 'Confirm',
        cancelText = 'Cancel'
    ) => {
        setState({
            ...initialState,
            isOpen: true,
            title,
            message,
            type: 'confirm',
            confirmText,
            cancelText,
            onConfirm,
            onCancel,
        });
    }, []);

    const closeModal = useCallback(() => {
        setState(prev => ({ ...prev, isOpen: false }));
    }, []);

    const ModalComponent = useCallback(() => (
        <Modal
            isOpen={state.isOpen}
            title={state.title}
            message={state.message}
            type={state.type}
            confirmText={state.confirmText}
            cancelText={state.cancelText}
            onConfirm={state.onConfirm}
            onCancel={state.onCancel}
            onClose={closeModal}
        />
    ), [state, closeModal]);

    return {
        showModal,
        showInfo,
        showSuccess,
        showError,
        showConfirm,
        closeModal,
        ModalComponent,
        isOpen: state.isOpen,
    };
}

export default Modal;
