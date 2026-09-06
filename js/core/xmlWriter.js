// js/core/xmlWriter.js — Form state → XML string.
//
// See web-implementation-spec.md §10 (XML Writing). Implemented in
// IMPLEMENTATION_PLAN.md Phase 2.3.
//
// Pure logic, no DOM dependencies beyond building/serializing an XML Document
// (createElementNS, XMLSerializer). Shares the isTransparent / isAttribute /
// isLeaf / isRepeatingContentContainer / joinPath helpers defined alongside
// js/core/xmlReader.js (see spec §10 "Shared Helper Predicates").

export {};
