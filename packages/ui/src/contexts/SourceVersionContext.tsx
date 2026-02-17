import React, { createContext, useContext, useState, ReactNode } from 'react';

// Context to track when sources change (for triggering re-renders)
interface SourceVersionContextType {
    version: number;
    incrementVersion: () => void;
}

const SourceVersionContext = createContext<SourceVersionContextType>({
    version: 0,
    incrementVersion: () => { },
});

export function SourceVersionProvider({ children }: { children: ReactNode }) {
    const [version, setVersion] = useState(0);

    const incrementVersion = () => {
        setVersion(v => v + 1);
    };

    return (
        <SourceVersionContext.Provider value={{ version, incrementVersion }}>
            {children}
        </SourceVersionContext.Provider>
    );
}

export function useSourceVersion() {
    return useContext(SourceVersionContext);
}
