// Central mangler for trait-method symbols.
//
// Symbol shape: `<structModuleId>__<StructName>__<TraitName>__<methodName>`.
//
// The struct's moduleId scopes the namespace; the trait name disambiguates
// between same-named methods coming from different traits implemented by one
// struct. Orphan impls aren't allowed, so the trait name is unique within a
// given type-decl's `implements` clause, which means this mangle is collision-
// free without needing the trait's moduleId in the symbol.

export function mangleTraitMethod(structType, traitName, methodName) {
  return `${structType.moduleId}__${structType.name}__${traitName}__${methodName}`;
}
