import React, { createContext, useContext } from 'react';

type SubjectContextValue = {
  subjectId: string | null;
  setSubjectId: (id: string | null) => void;
};

const SubjectContext = createContext<SubjectContextValue>({
  subjectId: null,
  setSubjectId: () => undefined,
});

export const SubjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <SubjectContext.Provider value={{ subjectId: null, setSubjectId: () => undefined }}>
      {children}
    </SubjectContext.Provider>
  );
};

export function useSubjectContext() {
  return useContext(SubjectContext);
}

export default { SubjectProvider, useSubjectContext };
