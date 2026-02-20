import { MultiviewCell } from '../MultiviewCell/MultiviewCell';
import { ViewerSlot } from '../../hooks/useMultiview';
import { useDraggable } from '../../hooks/useDraggable';
import './MultiviewLayout.css';

interface MultiviewLayoutProps {
    layout: 'main' | 'pip' | '2x2' | 'bigbottom';
    slots: ViewerSlot[];
    onSwapWithMain: (slotId: 2 | 3 | 4) => void;
    onStop: (slotId: 2 | 3 | 4) => void;
    onSetProperty: (slotId: 2 | 3 | 4, property: string, value: any) => void;
}

export function MultiviewLayout({
    layout,
    slots,
    onSwapWithMain,
    onStop,
    onSetProperty,
}: MultiviewLayoutProps) {
    const slot2 = slots.find(s => s.id === 2)!;
    const slot3 = slots.find(s => s.id === 3)!;
    const slot4 = slots.find(s => s.id === 4)!;
    const pipDragRef = useDraggable();

    const cell = (slot: ViewerSlot) => (
        <MultiviewCell
            key={slot.id}
            slotId={slot.id}
            channelName={slot.channelName}
            channelUrl={slot.channelUrl}
            active={slot.active}
            onSwapWithMain={() => onSwapWithMain(slot.id)}
            onStop={() => onStop(slot.id)}
            onSetProperty={(prop: string, val: any) => onSetProperty(slot.id, prop, val)}
        />
    );

    if (layout === 'main') {
        // MPV fills the window — no cells visible
        return null;
    }

    if (layout === 'pip') {
        return (
            <div className="layout-pip-container">
                <div className="layout-pip-overlay" ref={pipDragRef}>
                    {cell(slot2)}
                </div>
            </div>
        );
    }

    if (layout === '2x2') {
        return (
            <div className="layout-2x2-cells">
                {/* Top-left is MPV (empty div, MPV renders behind) */}
                <div className="layout-mpv-placeholder layout-2x2-mpv" />
                {cell(slot2)}
                {cell(slot3)}
                {cell(slot4)}
            </div>
        );
    }

    if (layout === 'bigbottom') {
        return (
            <div className="layout-bigbottom-cells">
                {/* Top is MPV */}
                <div className="layout-mpv-placeholder layout-bigbottom-mpv" />
                <div className="layout-bottom-bar">
                    {cell(slot2)}
                    {cell(slot3)}
                    {cell(slot4)}
                </div>
            </div>
        );
    }

    return null;
}
