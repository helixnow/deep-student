import type { ApiConfig, VendorConfig } from '../types';

const UNKNOWN_VENDOR_ORDER = Number.MAX_SAFE_INTEGER;

type VendorSortInput = Pick<VendorConfig, 'id' | 'name' | 'providerType' | 'sortOrder'>;

type ApiSortInput = Pick<ApiConfig, 'vendorId' | 'vendorName' | 'providerType' | 'isFavorite'>;

export interface UnifiedModelSortInput {
  vendorId?: string;
  vendorName?: string;
  providerName?: string;
  providerType?: string;
  vendorSortOrder?: number;
  isFavorite?: boolean;
  sourceIndex?: number;
}

const normalize = (value?: string | null) => (value ?? '').trim().toLowerCase();

const isSiliconFlowVendor = (vendor: Pick<VendorConfig, 'providerType'>) =>
  normalize(vendor.providerType) === 'siliconflow';

export const sortVendorsBySettingsOrder = <T extends VendorSortInput>(vendors: readonly T[]): T[] =>
  [...vendors].sort((a, b) => {
    const aSilicon = isSiliconFlowVendor(a);
    const bSilicon = isSiliconFlowVendor(b);
    if (aSilicon !== bSilicon) {
      return aSilicon ? -1 : 1;
    }

    const aOrder = a.sortOrder ?? UNKNOWN_VENDOR_ORDER;
    const bOrder = b.sortOrder ?? UNKNOWN_VENDOR_ORDER;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }

    return a.name.localeCompare(b.name);
  });

export const buildVendorOrderMap = (vendors: readonly VendorSortInput[]) => {
  const orderMap = new Map<string, number>();
  sortVendorsBySettingsOrder(vendors).forEach((vendor, index) => {
    orderMap.set(vendor.id, index);
  });
  return orderMap;
};

const getApiVendorOrder = (api: ApiSortInput, vendorOrderMap: Map<string, number>) =>
  api.vendorId ? (vendorOrderMap.get(api.vendorId) ?? UNKNOWN_VENDOR_ORDER) : UNKNOWN_VENDOR_ORDER;

const getApiVendorFallbackName = (api: ApiSortInput) =>
  normalize(api.vendorName) || normalize(api.providerType);

export const sortApiConfigsByVendorOrder = <T extends ApiSortInput>(
  apis: readonly T[],
  vendors: readonly VendorSortInput[]
): T[] => {
  const vendorOrderMap = buildVendorOrderMap(vendors);

  return apis
    .map((api, sourceIndex) => ({ api, sourceIndex }))
    .sort((left, right) => {
      const aOrder = getApiVendorOrder(left.api, vendorOrderMap);
      const bOrder = getApiVendorOrder(right.api, vendorOrderMap);
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }

      if (aOrder === UNKNOWN_VENDOR_ORDER) {
        const aName = getApiVendorFallbackName(left.api);
        const bName = getApiVendorFallbackName(right.api);
        if (aName !== bName) {
          return aName.localeCompare(bName);
        }
      }

      const aFavorite = left.api.isFavorite === true;
      const bFavorite = right.api.isFavorite === true;
      if (aFavorite !== bFavorite) {
        return aFavorite ? -1 : 1;
      }

      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ api }) => api);
};

const getSelectorVendorOrder = (model: UnifiedModelSortInput) =>
  typeof model.vendorSortOrder === 'number' && Number.isFinite(model.vendorSortOrder)
    ? model.vendorSortOrder
    : UNKNOWN_VENDOR_ORDER;

const getSelectorVendorKey = (model: UnifiedModelSortInput) =>
  normalize(model.vendorId) ||
  normalize(model.vendorName) ||
  normalize(model.providerName) ||
  normalize(model.providerType);

export const sortUnifiedModelInfosForSelector = <T extends UnifiedModelSortInput>(
  models: readonly T[]
): T[] => {
  const hasVendorMetadata = models.some(
    (model) => getSelectorVendorOrder(model) !== UNKNOWN_VENDOR_ORDER || getSelectorVendorKey(model)
  );

  return models
    .map((model, fallbackIndex) => ({
      model,
      sourceIndex: model.sourceIndex ?? fallbackIndex,
    }))
    .sort((left, right) => {
      const aOrder = getSelectorVendorOrder(left.model);
      const bOrder = getSelectorVendorOrder(right.model);

      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }

      const aVendorKey = getSelectorVendorKey(left.model);
      const bVendorKey = getSelectorVendorKey(right.model);
      const sameVendor = aVendorKey === bVendorKey;

      if (hasVendorMetadata && !sameVendor) {
        if (aOrder === UNKNOWN_VENDOR_ORDER && bOrder === UNKNOWN_VENDOR_ORDER && aVendorKey && bVendorKey) {
          return aVendorKey.localeCompare(bVendorKey);
        }
        return left.sourceIndex - right.sourceIndex;
      }

      const aFavorite = left.model.isFavorite === true;
      const bFavorite = right.model.isFavorite === true;
      if (aFavorite !== bFavorite) {
        return aFavorite ? -1 : 1;
      }

      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ model }) => model);
};
