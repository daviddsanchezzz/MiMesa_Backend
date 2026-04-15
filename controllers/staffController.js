const StaffEmployee = require('../models/StaffEmployee');
const StaffCompensation = require('../models/StaffCompensation');
const StaffAssignment = require('../models/StaffAssignment');
const StaffPosition = require('../models/StaffPosition');
const Shift = require('../models/Shift');

function isValidIsoDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function isValidTime(value) {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value);
}

function startOfWeekMonday(inputDate) {
  const date = new Date(`${inputDate}T12:00:00`);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function timeToMinutes(time) {
  if (!isValidTime(time)) return 0;
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function assignmentMinutes(assignment, shiftById) {
  let start = assignment.startTime;
  let end = assignment.endTime;

  if ((!start || !end) && assignment.shiftId) {
    const shift = shiftById.get(String(assignment.shiftId));
    if (shift) {
      start = start || shift.startTime;
      end = end || shift.endTime;
    }
  }

  if (!isValidTime(start) || !isValidTime(end)) return 0;

  const startMin = timeToMinutes(start);
  let endMin = timeToMinutes(end);
  if (endMin <= startMin) endMin += 24 * 60;

  return Math.max(endMin - startMin, 0);
}

function normalizePositionName(name = '') {
  return String(name).trim().toLowerCase();
}

function isValidHexColor(value = '') {
  return /^#([A-Fa-f0-9]{6})$/.test(String(value).trim());
}

async function resolveEmployeePosition({ businessId, positionIds, positionId, position }) {
  let requested = [];

  if (Array.isArray(positionIds)) requested = positionIds.filter(Boolean).map(String);
  if (!requested.length && positionId) requested = [String(positionId)];
  requested = [...new Set(requested)];

  if (requested.length) {
    const rows = await StaffPosition.find({
      _id: { $in: requested },
      businessId,
      status: 'active',
    }).lean();

    if (rows.length !== requested.length) {
      return { error: 'Uno o varios puestos no son validos o estan inactivos' };
    }

    const rowById = new Map(rows.map((row) => [String(row._id), row]));
    const ordered = requested.map((id) => rowById.get(id)).filter(Boolean);

    return {
      positionIds: ordered.map((row) => row._id),
      positionId: ordered[0]?._id || null,
      position: ordered[0]?.name || '',
      positions: ordered,
    };
  }

  return {
    positionIds: [],
    positionId: null,
    position: String(position || '').trim(),
    positions: [],
  };
}

async function getActiveCompensationMap(businessId, employeeIds) {
  if (!employeeIds.length) return new Map();

  const rows = await StaffCompensation.find({
    businessId,
    employeeId: { $in: employeeIds },
    isActive: true,
  }).sort({ effectiveFrom: -1 }).lean();

  const map = new Map();
  rows.forEach((row) => {
    const key = String(row.employeeId);
    if (!map.has(key)) map.set(key, row);
  });

  return map;
}

exports.getEmployees = async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const filter = { businessId: req.businessId };
    if (!includeInactive) filter.status = 'active';

    const employees = await StaffEmployee.find(filter).sort({ firstName: 1, lastName: 1 }).lean();
    const [compensationMap, positions] = await Promise.all([
      getActiveCompensationMap(
        req.businessId,
        employees.map((e) => e._id),
      ),
      StaffPosition.find({ businessId: req.businessId }).select('_id name color status').lean(),
    ]);
    const positionMap = new Map(positions.map((p) => [String(p._id), p]));

    res.json(employees.map((employee) => {
      const ids = Array.isArray(employee.positionIds) && employee.positionIds.length
        ? employee.positionIds.map(String)
        : employee.positionId
          ? [String(employee.positionId)]
          : [];
      const resolvedPositions = ids.map((id) => positionMap.get(id)).filter(Boolean);
      const positionRef = resolvedPositions[0] || null;
      return {
        ...employee,
        positionIds: resolvedPositions.map((p) => p._id),
        positions: resolvedPositions.map((p) => ({
          _id: p._id,
          name: p.name,
          color: p.color,
          status: p.status,
        })),
        positionId: positionRef?._id || null,
        position: positionRef?.name || employee.position || '',
        positionColor: positionRef?.color || null,
        positionStatus: positionRef?.status || null,
        activeCompensation: compensationMap.get(String(employee._id)) || null,
      };
    }));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getPositions = async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const filter = { businessId: req.businessId };
    if (!includeInactive) filter.status = 'active';
    const rows = await StaffPosition.find(filter).sort({ name: 1 }).lean();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createPosition = async (req, res) => {
  try {
    const { name, color = '#64748B' } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ message: 'El nombre del puesto es obligatorio' });
    if (!isValidHexColor(color)) return res.status(400).json({ message: 'Color invalido (usa formato #RRGGBB)' });

    const row = await StaffPosition.create({
      businessId: req.businessId,
      name: String(name).trim(),
      color: String(color).toUpperCase(),
      normalizedName: normalizePositionName(name),
      status: 'active',
    });
    res.status(201).json(row);
  } catch (err) {
    if (String(err?.message || '').includes('duplicate key')) {
      return res.status(409).json({ message: 'Ya existe un puesto con ese nombre' });
    }
    res.status(400).json({ message: err.message });
  }
};

exports.updatePosition = async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.name !== undefined) {
      if (!String(payload.name).trim()) return res.status(400).json({ message: 'El nombre del puesto es obligatorio' });
      payload.name = String(payload.name).trim();
      payload.normalizedName = normalizePositionName(payload.name);
    }
    if (payload.color !== undefined) {
      if (!isValidHexColor(payload.color)) return res.status(400).json({ message: 'Color invalido (usa formato #RRGGBB)' });
      payload.color = String(payload.color).toUpperCase();
    }

    const row = await StaffPosition.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      payload,
      { new: true, runValidators: true },
    );
    if (!row) return res.status(404).json({ message: 'Puesto no encontrado' });

    if (payload.name !== undefined) {
      await StaffEmployee.updateMany(
        { businessId: req.businessId, positionId: row._id },
        { $set: { position: row.name } },
      );
    }

    res.json(row);
  } catch (err) {
    if (String(err?.message || '').includes('duplicate key')) {
      return res.status(409).json({ message: 'Ya existe un puesto con ese nombre' });
    }
    res.status(400).json({ message: err.message });
  }
};

exports.setPositionStatus = async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['active', 'inactive'].includes(status)) return res.status(400).json({ message: 'Estado invalido' });
    const row = await StaffPosition.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      { status },
      { new: true },
    );
    if (!row) return res.status(404).json({ message: 'Puesto no encontrado' });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.createEmployee = async (req, res) => {
  try {
    const {
      firstName,
      lastName = '',
      phone = '',
      email = '',
      positionIds = [],
      positionId = null,
      position = '',
      notes = '',
    } = req.body || {};

    if (!firstName?.trim()) return res.status(400).json({ message: 'El nombre es obligatorio' });

    const resolvedPosition = await resolveEmployeePosition({
      businessId: req.businessId,
      positionIds,
      positionId,
      position,
    });
    if (resolvedPosition.error) return res.status(400).json({ message: resolvedPosition.error });

    const employee = await StaffEmployee.create({
      businessId: req.businessId,
      firstName: firstName.trim(),
      lastName: String(lastName).trim(),
      phone: String(phone).trim(),
      email: String(email).trim().toLowerCase(),
      positionIds: resolvedPosition.positionIds,
      positionId: resolvedPosition.positionId,
      position: resolvedPosition.position,
      notes: String(notes),
      status: 'active',
    });

    res.status(201).json(employee);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.updateEmployee = async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.firstName !== undefined) payload.firstName = String(payload.firstName).trim();
    if (payload.lastName !== undefined) payload.lastName = String(payload.lastName).trim();
    if (payload.phone !== undefined) payload.phone = String(payload.phone).trim();
    if (payload.email !== undefined) payload.email = String(payload.email).trim().toLowerCase();
    if (payload.position !== undefined) payload.position = String(payload.position).trim();

    if (payload.positionIds !== undefined || payload.positionId !== undefined || payload.position !== undefined) {
      const resolvedPosition = await resolveEmployeePosition({
        businessId: req.businessId,
        positionIds: payload.positionIds,
        positionId: payload.positionId,
        position: payload.position,
      });
      if (resolvedPosition.error) return res.status(400).json({ message: resolvedPosition.error });
      payload.positionIds = resolvedPosition.positionIds;
      payload.positionId = resolvedPosition.positionId;
      payload.position = resolvedPosition.position;
    }

    const employee = await StaffEmployee.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      payload,
      { new: true, runValidators: true },
    );

    if (!employee) return res.status(404).json({ message: 'Empleado no encontrado' });
    res.json(employee);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.setEmployeeStatus = async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ message: 'Estado invalido' });
    }

    const employee = await StaffEmployee.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      {
        status,
        archivedAt: status === 'inactive' ? new Date() : null,
      },
      { new: true },
    );

    if (!employee) return res.status(404).json({ message: 'Empleado no encontrado' });
    res.json(employee);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.getEmployeeCompensations = async (req, res) => {
  try {
    const employee = await StaffEmployee.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
    if (!employee) return res.status(404).json({ message: 'Empleado no encontrado' });

    const rows = await StaffCompensation.find({
      businessId: req.businessId,
      employeeId: req.params.id,
    }).sort({ effectiveFrom: -1, createdAt: -1 });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createEmployeeCompensation = async (req, res) => {
  try {
    const employee = await StaffEmployee.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
    if (!employee) return res.status(404).json({ message: 'Empleado no encontrado' });

    const {
      paymentType,
      baseAmount,
      currency = 'EUR',
      effectiveFrom,
      notes = '',
    } = req.body || {};

    if (!['hourly', 'per_shift', 'monthly_fixed'].includes(paymentType)) {
      return res.status(400).json({ message: 'Tipo de pago invalido' });
    }
    if (typeof baseAmount !== 'number' || baseAmount < 0) {
      return res.status(400).json({ message: 'Importe base invalido' });
    }
    if (!isValidIsoDate(effectiveFrom)) {
      return res.status(400).json({ message: 'effectiveFrom debe tener formato YYYY-MM-DD' });
    }

    await StaffCompensation.updateMany(
      { businessId: req.businessId, employeeId: req.params.id, isActive: true },
      { $set: { isActive: false } },
    );

    const row = await StaffCompensation.create({
      businessId: req.businessId,
      employeeId: req.params.id,
      paymentType,
      baseAmount,
      currency: String(currency).toUpperCase(),
      effectiveFrom,
      notes: String(notes),
      isActive: true,
    });

    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.getAssignments = async (req, res) => {
  try {
    const weekStartRaw = req.query.weekStart;
    if (!isValidIsoDate(weekStartRaw)) {
      return res.status(400).json({ message: 'weekStart requerido (YYYY-MM-DD)' });
    }

    const weekStart = startOfWeekMonday(weekStartRaw);
    const weekEnd = addDays(weekStart, 6);

    const [employees, assignments] = await Promise.all([
      StaffEmployee.find({ businessId: req.businessId }).sort({ firstName: 1, lastName: 1 }).lean(),
      StaffAssignment.find({
        businessId: req.businessId,
        date: { $gte: weekStart, $lte: weekEnd },
      })
        .populate('shiftId', 'name startTime endTime')
        .populate('employeeId', 'firstName lastName status position positionId')
        .sort({ date: 1, startTime: 1, createdAt: 1 })
        .lean(),
    ]);

    res.json({ weekStart, weekEnd, employees, assignments });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createAssignment = async (req, res) => {
  try {
    const {
      employeeId,
      date,
      shiftId = null,
      roleLabel = '',
      notes = '',
    } = req.body || {};

    if (!employeeId) return res.status(400).json({ message: 'employeeId es obligatorio' });
    if (!isValidIsoDate(date)) return res.status(400).json({ message: 'date invalida' });

    const employee = await StaffEmployee.findOne({
      _id: employeeId,
      businessId: req.businessId,
    }).lean();
    if (!employee) return res.status(404).json({ message: 'Empleado no encontrado' });

    if (!shiftId) return res.status(400).json({ message: 'shiftId es obligatorio' });

    const shift = await Shift.findOne({ _id: shiftId, businessId: req.businessId }).lean();
    if (!shift) return res.status(404).json({ message: 'Turno no encontrado' });

    const assignment = await StaffAssignment.create({
      businessId: req.businessId,
      employeeId,
      date,
      shiftId,
      startTime: '',
      endTime: '',
      roleLabel: String(roleLabel).trim(),
      notes: String(notes),
    });

    const populated = await StaffAssignment.findById(assignment._id)
      .populate('shiftId', 'name startTime endTime')
      .populate('employeeId', 'firstName lastName status position positionId');

    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.updateAssignment = async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.date && !isValidIsoDate(payload.date)) {
      return res.status(400).json({ message: 'date invalida' });
    }
    if (payload.startTime !== undefined || payload.endTime !== undefined) {
      return res.status(400).json({ message: 'No se permite editar rango horario manual' });
    }
    if (payload.shiftId !== undefined) {
      if (!payload.shiftId) {
        return res.status(400).json({ message: 'shiftId no puede ser vacio' });
      }
      const shift = await Shift.findOne({ _id: payload.shiftId, businessId: req.businessId }).lean();
      if (!shift) return res.status(404).json({ message: 'Turno no encontrado' });
    }

    const assignment = await StaffAssignment.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      payload,
      { new: true, runValidators: true },
    )
      .populate('shiftId', 'name startTime endTime')
      .populate('employeeId', 'firstName lastName status position positionId');

    if (!assignment) return res.status(404).json({ message: 'Asignacion no encontrada' });
    res.json(assignment);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.deleteAssignment = async (req, res) => {
  try {
    const deleted = await StaffAssignment.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId,
    });

    if (!deleted) return res.status(404).json({ message: 'Asignacion no encontrada' });
    res.json({ message: 'Asignacion eliminada' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getWeeklyCosts = async (req, res) => {
  try {
    const weekStartRaw = req.query.weekStart;
    if (!isValidIsoDate(weekStartRaw)) {
      return res.status(400).json({ message: 'weekStart requerido (YYYY-MM-DD)' });
    }

    const weekStart = startOfWeekMonday(weekStartRaw);
    const weekEnd = addDays(weekStart, 6);

    const [employees, assignments] = await Promise.all([
      StaffEmployee.find({ businessId: req.businessId }).lean(),
      StaffAssignment.find({
        businessId: req.businessId,
        date: { $gte: weekStart, $lte: weekEnd },
      }).lean(),
    ]);

    const shiftIds = [...new Set(assignments.map((a) => a.shiftId).filter(Boolean).map(String))];
    const shifts = await Shift.find({ _id: { $in: shiftIds }, businessId: req.businessId })
      .select('startTime endTime')
      .lean();
    const shiftById = new Map(shifts.map((s) => [String(s._id), s]));

    const compensationMap = await getActiveCompensationMap(
      req.businessId,
      employees.map((e) => e._id),
    );

    const assignmentsByEmployee = assignments.reduce((acc, row) => {
      const key = String(row.employeeId);
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});

    const employeeCosts = employees.map((employee) => {
      const key = String(employee._id);
      const comp = compensationMap.get(key);
      const rows = assignmentsByEmployee[key] || [];

      const totalMinutes = rows.reduce((sum, row) => sum + assignmentMinutes(row, shiftById), 0);
      const hours = Number((totalMinutes / 60).toFixed(2));

      let weeklyCost = 0;
      let currency = comp?.currency || 'EUR';

      if (comp) {
        if (comp.paymentType === 'hourly') {
          weeklyCost = hours * comp.baseAmount;
        } else if (comp.paymentType === 'per_shift') {
          weeklyCost = rows.length * comp.baseAmount;
        } else if (comp.paymentType === 'monthly_fixed') {
          weeklyCost = comp.baseAmount / 4.33;
        }
      }

      return {
        employeeId: employee._id,
        employeeName: `${employee.firstName} ${employee.lastName || ''}`.trim(),
        employeeStatus: employee.status,
        assignments: rows.length,
        totalHours: hours,
        compensation: comp || null,
        currency,
        weeklyCost: Number(weeklyCost.toFixed(2)),
      };
    });

    const totalsByCurrency = employeeCosts.reduce((acc, row) => {
      acc[row.currency] = Number(((acc[row.currency] || 0) + row.weeklyCost).toFixed(2));
      return acc;
    }, {});

    const monthlyEstimateByCurrency = Object.entries(totalsByCurrency).reduce((acc, [currency, amount]) => {
      acc[currency] = Number((amount * 4.33).toFixed(2));
      return acc;
    }, {});

    res.json({
      weekStart,
      weekEnd,
      employeeCosts,
      totalsByCurrency,
      monthlyEstimateByCurrency,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
